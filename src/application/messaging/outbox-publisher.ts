import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { DEFAULT_OUTBOX_BACKOFF, OutboxMessage } from '../../domain/messaging/outbox-message';
import type { Env } from '../../infrastructure/config/env';
import type { EventQueuePort } from '../../infrastructure/messaging/sqs-event-queue';
import type { ApplicationMetrics } from '../observability/application-metrics';
import { logger } from '../observability/logger';
import type { Clock } from '../shared/clock';
import { newId } from '../shared/ids';

interface ClaimedOutboxRow {
  seq: string;
  id: string;
  aggregateId: string;
  groupKey: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt: Date | null;
}

export class OutboxPublisher {
  constructor(
    private readonly orm: MikroORM,
    private readonly queue: EventQueuePort,
    private readonly clock: Clock,
    private readonly batchSize: number,
    private readonly leaseSeconds: number,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  /** Claims a short lease, publishes outside the database transaction, then records the result. */
  async publishBatch(): Promise<number> {
    const claimToken = newId();
    const claimedAt = this.clock.now();
    const leaseUntil = new Date(claimedAt.getTime() + this.leaseSeconds * 1000);
    const rows = await this.orm.em
      .fork()
      .transactional(async (em) => this.claimBatch(em, claimToken, claimedAt, leaseUntil));
    rows.sort((left, right) => (BigInt(left.seq) < BigInt(right.seq) ? -1 : 1));
    await Promise.all(rows.map((row) => this.publishOne(row, claimToken)));
    return rows.length;
  }

  private async claimBatch(
    em: EntityManager,
    claimToken: string,
    now: Date,
    leaseUntil: Date,
  ): Promise<ClaimedOutboxRow[]> {
    return em.execute<ClaimedOutboxRow[]>(
      `with candidates as (
         select current.id
           from outbox_messages current
          where current.published_at is null
            and (current.next_attempt_at is null or current.next_attempt_at <= ?)
            and (current.claimed_until is null or current.claimed_until <= ?)
            and not exists (
              select 1 from outbox_messages earlier
               where earlier.group_key = current.group_key
                 and earlier.published_at is null
                 and earlier.seq < current.seq
            )
          order by current.seq
          limit ?
          for update of current skip locked
       )
       update outbox_messages message
          set claim_token = ?, claimed_until = ?
         from candidates
        where message.id = candidates.id
       returning message.seq, message.id, message.aggregate_id as "aggregateId",
                 message.group_key as "groupKey", message.event_type as "eventType",
                 message.payload, message.occurred_at as "occurredAt", message.attempts,
                 message.next_attempt_at as "nextAttemptAt"`,
      [now, now, this.batchSize, claimToken, leaseUntil],
    );
  }

  private async publishOne(row: ClaimedOutboxRow, claimToken: string): Promise<void> {
    try {
      await this.queue.publish({
        eventId: row.id,
        groupKey: row.groupKey,
        body: JSON.stringify(row.payload),
      });
    } catch (error) {
      this.metrics?.recordRetry('outbox');
      const now = this.clock.now();
      const message = OutboxMessage.rehydrate({
        id: row.id,
        aggregateId: row.aggregateId,
        groupKey: row.groupKey,
        eventType: row.eventType,
        payload: row.payload,
        occurredAt: new Date(row.occurredAt),
        attempts: row.attempts,
        nextAttemptAt: row.nextAttemptAt ? new Date(row.nextAttemptAt) : undefined,
      });
      message.scheduleRetry(now, DEFAULT_OUTBOX_BACKOFF);
      await this.orm.em.fork().execute(
        `update outbox_messages
            set attempts = ?, next_attempt_at = ?, claim_token = null, claimed_until = null
          where id = ? and claim_token = ? and published_at is null`,
        [message.attempts, message.nextAttemptAt, row.id, claimToken],
      );
      logger.warn(
        {
          component: 'outbox-publisher',
          eventId: row.id,
          eventType: row.eventType,
          aggregateId: row.aggregateId,
          walletId: row.groupKey,
          ...eventLogContext(row.payload),
          attempt: message.attempts,
          error: error instanceof Error ? error.name : 'UnknownError',
        },
        'outbox publish failed',
      );
      return;
    }

    const publishedAt = this.clock.now();
    await this.orm.em.fork().execute(
      `update outbox_messages
          set published_at = ?, next_attempt_at = null, claim_token = null, claimed_until = null
        where id = ? and claim_token = ? and published_at is null`,
      [publishedAt, row.id, claimToken],
    );
  }
}

function eventLogContext(payload: Record<string, unknown>): Record<string, string> {
  const data = isRecord(payload.data) ? payload.data : {};
  return {
    ...(typeof payload.correlationId === 'string' ? { correlationId: payload.correlationId } : {}),
    ...(typeof data.transactionId === 'string' ? { transactionId: data.transactionId } : {}),
    ...(typeof data.walletId === 'string' ? { walletId: data.walletId } : {}),
    ...(typeof data.providerId === 'string' ? { providerId: data.providerId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class OutboxPublisherWorker {
  private readonly abortController = new AbortController();
  private loopPromise?: Promise<void>;

  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.ROLES.includes('workers')) this.loopPromise = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.abortController.abort();
    await this.loopPromise;
  }

  private async run(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      let claimed = 0;
      try {
        claimed = await this.publisher.publishBatch();
      } catch (error) {
        logger.error(
          {
            component: 'outbox-publisher',
            error: error instanceof Error ? error.name : 'UnknownError',
          },
          'outbox batch failed',
        );
      }
      if (claimed > 0) continue;
      await delay(this.env.WORKER_POLL_INTERVAL_MS, this.abortController.signal);
    }
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
