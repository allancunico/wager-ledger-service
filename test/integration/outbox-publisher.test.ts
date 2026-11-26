import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { v7 as uuidv7 } from 'uuid';
import { OutboxPublisher } from '../../src/application/messaging/outbox-publisher';
import type { Clock } from '../../src/application/shared/clock';
import { WalletService } from '../../src/application/wallets/wallet-service';
import { Money } from '../../src/domain/shared/money';
import { loadEnv } from '../../src/infrastructure/config/env';
import { createOrm } from '../../src/infrastructure/database/orm';
import type { EventQueuePort } from '../../src/infrastructure/messaging/sqs-event-queue';
import { SqsEventQueue } from '../../src/infrastructure/messaging/sqs-event-queue';
import { OutboxMessageRecord } from '../../src/infrastructure/persistence/records';
import { createTestDatabase } from './helpers/database';

describe('outbox publisher', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let secondOrm: Awaited<ReturnType<typeof createOrm>>;
  let env: ReturnType<typeof loadEnv>;
  let sqs: SQSClient;
  let queue: SqsEventQueue;
  let queueName: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    secondOrm = await createOrm(database.databaseUrl);
    env = loadEnv();
    queueName = `wager-events-it-${uuidv7().replaceAll('-', '')}.fifo`;
    sqs = new SQSClient({
      region: env.AWS_REGION,
      endpoint: env.AWS_ENDPOINT_URL,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
      },
    });
    await sqs.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
      }),
    );
    queue = new SqsEventQueue(sqs, queueName);
  }, 30_000);

  afterAll(async () => {
    await secondOrm?.close(true);
    await database?.close();
    if (sqs && queueName) {
      const result = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }));
      if (result.QueueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: result.QueueUrl }));
      sqs.destroy();
    }
  });

  test('publishes committed events in wallet order and marks them published', async () => {
    const wallet = await new WalletService(database.orm, systemClock).create({
      playerId: uuidv7(),
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
    });
    const expected = await database.orm.em
      .fork()
      .execute<{ id: string; seq: string }[]>(
        'select id, seq from outbox_messages where group_key = ? order by seq',
        [wallet.id],
      );
    const publisher = new OutboxPublisher(database.orm, queue, systemClock, 50, 30);

    expect(await publisher.publishBatch()).toBe(1);
    expect(await publisher.publishBatch()).toBe(1);
    expect(await publisher.publishBatch()).toBe(0);
    expect(
      await database.orm.em
        .fork()
        .count(OutboxMessageRecord, { groupKey: wallet.id, publishedAt: { $ne: null } }),
    ).toBe(2);

    const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
    if (!url) throw new Error('Fila de teste sem URL');
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    const messages = received.Messages ?? [];
    expect(messages).toHaveLength(2);
    expect(
      messages.map((message) => (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId),
    ).toEqual(expected.map((row) => row.id));
    expect(messages.map((message) => message.Attributes?.MessageGroupId)).toEqual([
      wallet.id,
      wallet.id,
    ]);
    expect(messages.map((message) => message.Attributes?.MessageDeduplicationId)).toEqual(
      expected.map((row) => row.id),
    );
  });

  test('releases a failed claim with backoff and later publishes it', async () => {
    const wallet = await new WalletService(database.orm, systemClock).create({
      playerId: uuidv7(),
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });
    const fakeClock = new MutableClock(new Date('2026-11-25T12:00:00.000Z'));
    const failingQueue = new FailOnceQueue();
    const publisher = new OutboxPublisher(database.orm, failingQueue, fakeClock, 50, 30);

    expect(await publisher.publishBatch()).toBe(1);
    const [failed] = await database.orm.em
      .fork()
      .execute<{ attempts: number; claimToken: string | null; nextAttemptAt: Date | null }[]>(
        `select attempts, claim_token as "claimToken", next_attempt_at as "nextAttemptAt"
         from outbox_messages where group_key = ? order by seq limit 1`,
        [wallet.id],
      );
    expect(failed?.attempts).toBe(1);
    expect(failed?.claimToken).toBeNull();
    expect(failed?.nextAttemptAt).not.toBeNull();

    fakeClock.advance(2_000);
    expect(await publisher.publishBatch()).toBe(1);
    expect(await publisher.publishBatch()).toBe(1);
    expect(
      await database.orm.em
        .fork()
        .count(OutboxMessageRecord, { groupKey: wallet.id, publishedAt: { $ne: null } }),
    ).toBe(2);
    expect(failingQueue.publishedIds).toHaveLength(2);
  });

  test('a second publisher skips an event while another worker holds its lease', async () => {
    const wallet = await new WalletService(database.orm, systemClock).create({
      playerId: uuidv7(),
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });
    const blockingQueue = new FirstSendBlockingQueue();
    const firstPublisher = new OutboxPublisher(database.orm, blockingQueue, systemClock, 50, 30);
    const secondPublisher = new OutboxPublisher(secondOrm, blockingQueue, systemClock, 50, 30);

    const firstClaim = firstPublisher.publishBatch();
    await blockingQueue.firstSendStarted;
    expect(await secondPublisher.publishBatch()).toBe(0);
    blockingQueue.releaseFirstSend();
    expect(await firstClaim).toBe(1);
    expect(await secondPublisher.publishBatch()).toBe(1);
    expect(await secondPublisher.publishBatch()).toBe(0);
    expect(new Set(blockingQueue.publishedIds).size).toBe(2);
    expect(blockingQueue.publishedIds).toHaveLength(2);
    expect(
      await database.orm.em
        .fork()
        .count(OutboxMessageRecord, { groupKey: wallet.id, publishedAt: { $ne: null } }),
    ).toBe(2);
  });

  test('recovers when SQS accepted an event but the published marker failed', async () => {
    const wallet = await new WalletService(database.orm, systemClock).create({
      playerId: uuidv7(),
      initialBalance: Money.from({ amount: '1.00', currency: 'BRL' }),
    });
    const [target] = await database.orm.em
      .fork()
      .execute<{ id: string }[]>(
        'select id from outbox_messages where group_key = ? order by seq limit 1',
        [wallet.id],
      );
    if (!target) throw new Error('Wallet não gerou evento na outbox');

    const em = database.orm.em.fork();
    await em.execute(`
      create function fail_outbox_publish_mark_for_test() returns trigger language plpgsql as $$
      begin
        if old.id = '${target.id}'::uuid
           and old.published_at is null
           and new.published_at is not null then
          raise exception 'simulated crash after SQS accepted event';
        end if;
        return new;
      end;
      $$;
      create trigger fail_outbox_publish_mark_for_test
        before update on outbox_messages
        for each row execute function fail_outbox_publish_mark_for_test();
    `);

    const clock = new MutableClock(new Date('2026-11-25T12:00:00.000Z'));
    const recordingQueue = new RecordingEventQueue(queue);
    const firstPublisher = new OutboxPublisher(database.orm, recordingQueue, clock, 50, 30);
    try {
      await expect(firstPublisher.publishBatch()).rejects.toThrow(
        'simulated crash after SQS accepted event',
      );
    } finally {
      await em.execute(
        'drop trigger if exists fail_outbox_publish_mark_for_test on outbox_messages',
      );
      await em.execute('drop function if exists fail_outbox_publish_mark_for_test()');
    }

    expect(recordingQueue.publishedIds).toEqual([target.id]);
    const [afterFailedMark] = await em.execute<
      { publishedAt: Date | null; claimToken: string | null }[]
    >(
      `select published_at as "publishedAt", claim_token as "claimToken"
         from outbox_messages where id = ?`,
      [target.id],
    );
    expect(afterFailedMark?.publishedAt).toBeNull();
    expect(afterFailedMark?.claimToken).not.toBeNull();

    // A new process can claim the event after the first publisher's lease expires.
    clock.advance(30_001);
    const secondPublisher = new OutboxPublisher(secondOrm, recordingQueue, clock, 50, 30);
    expect(await secondPublisher.publishBatch()).toBe(1);
    expect(recordingQueue.publishedIds).toEqual([target.id, target.id]);

    const [published] = await em.execute<{ publishedAt: Date | null; claimToken: string | null }[]>(
      `select published_at as "publishedAt", claim_token as "claimToken"
         from outbox_messages where id = ?`,
      [target.id],
    );
    expect(published?.publishedAt).not.toBeNull();
    expect(published?.claimToken).toBeNull();

    // Both sends used the same FIFO deduplication ID, so SQS exposes one copy.
    const url = (await sqs.send(new GetQueueUrlCommand({ QueueName: queueName }))).QueueUrl;
    if (!url) throw new Error('Fila de teste sem URL');
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageDeduplicationId'],
      }),
    );
    const targetMessages = (received.Messages ?? []).filter(
      (message) => (JSON.parse(message.Body ?? '{}') as { eventId?: string }).eventId === target.id,
    );
    expect(targetMessages).toHaveLength(1);
    expect(targetMessages[0]?.Attributes?.MessageDeduplicationId).toBe(target.id);
  });
});

const systemClock: Clock = { now: () => new Date() };

class MutableClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

class FailOnceQueue {
  readonly publishedIds: string[] = [];
  private fail = true;

  async publish(input: { eventId: string }): Promise<void> {
    if (this.fail) {
      this.fail = false;
      throw new Error('simulated SQS outage');
    }
    this.publishedIds.push(input.eventId);
  }
}

class FirstSendBlockingQueue implements EventQueuePort {
  readonly publishedIds: string[] = [];
  readonly firstSendStarted: Promise<void>;
  private resolveStarted!: () => void;
  private releaseSend!: () => void;
  private blockFirst = true;

  constructor() {
    this.firstSendStarted = new Promise((resolve) => {
      this.resolveStarted = resolve;
    });
  }

  async publish(input: { eventId: string }): Promise<void> {
    if (this.blockFirst) {
      this.blockFirst = false;
      this.resolveStarted();
      await new Promise<void>((resolve) => {
        this.releaseSend = resolve;
      });
    }
    this.publishedIds.push(input.eventId);
  }

  releaseFirstSend(): void {
    this.releaseSend();
  }
}

class RecordingEventQueue implements EventQueuePort {
  readonly publishedIds: string[] = [];

  constructor(private readonly delegate: EventQueuePort) {}

  async publish(input: { eventId: string; groupKey: string; body: string }): Promise<void> {
    await this.delegate.publish(input);
    this.publishedIds.push(input.eventId);
  }
}
