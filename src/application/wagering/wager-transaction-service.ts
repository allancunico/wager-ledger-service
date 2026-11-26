import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import { hashPayload } from '../../domain/wagering/payload-hash';
import { PendingReferencePolicy } from '../../domain/wagering/pending-reference-policy';
import { processTransaction } from '../../domain/wagering/wager-rules';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { Env } from '../../infrastructure/config/env';
import {
  ledgerEntryToRecord,
  outboxMessageToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
} from '../../infrastructure/persistence/mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../infrastructure/persistence/records';
import type { ApplicationMetrics } from '../observability/application-metrics';
import { logger } from '../observability/logger';
import type { Clock } from '../shared/clock';
import { newId } from '../shared/ids';
import { WalletService } from '../wallets/wallet-service';

export class IdempotencyConflictError extends Error {}
export class ExternalTransactionConflictError extends Error {}
export class InboxMessageConflictError extends Error {}

export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
}

export interface TransactionResult {
  httpStatus: 200 | 201 | 202 | 422 | 500;
  body: Record<string, unknown>;
}

export class WagerTransactionService {
  private readonly pendingPolicy: PendingReferencePolicy;
  private readonly pendingTtlSeconds: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    env: Env,
    private readonly metrics?: ApplicationMetrics,
  ) {
    this.lockTimeoutMs = env.LOCK_TIMEOUT_MS;
    this.pendingTtlSeconds = env.PENDING_REFERENCE_TTL_SECONDS;
    this.pendingPolicy = new PendingReferencePolicy({
      ttlSeconds: env.PENDING_REFERENCE_TTL_SECONDS,
      backoff: {
        baseSeconds: env.PENDING_REFERENCE_BACKOFF_BASE_SECONDS,
        maxSeconds: env.PENDING_REFERENCE_BACKOFF_MAX_SECONDS,
        jitterRatio: 0.2,
      },
    });
  }

  async submit(input: SubmitWagerInput): Promise<TransactionResult> {
    return this.submitInternal(input);
  }

  async submitFromQueue(
    input: SubmitWagerInput,
    message: { consumerName: string; messageId: string },
  ): Promise<TransactionResult & { duplicateMessage?: boolean }> {
    return this.submitInternal(input, message);
  }

  /** Persiste FAILED em melhor esforço quando o SQS já está na última entrega. */
  async recordQueueAttemptsExhausted(input: SubmitWagerInput): Promise<void> {
    const payloadHash = hashPayload(input);
    const now = this.clock.now();
    await this.orm.em.fork().transactional(async (em) => {
      const existing = await em.findOne(WagerTransactionRecord, {
        providerId: input.providerId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) return;
      const sameExternal = await em.findOne(WagerTransactionRecord, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });
      if (sameExternal) return;

      await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
      const walletRecord = await WalletService.lockWallet(em, input.walletId);
      if (!walletRecord) return;
      const failed = WagerTransaction.create({
        id: newId(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: input.money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
      });
      failed.fail(FailureCode.ProcessingAttemptsExhausted, now);
      await em.insert(WagerTransactionRecord, wagerTransactionToRecord(failed));
    });
  }

  /** Reavalia um lote de referências vencidas, uma transação SQL por item. */
  async reprocessPendingReferences(batchSize: number): Promise<number> {
    let processed = 0;
    while (processed < batchSize) {
      const didProcess = await this.orm.em.fork().transactional(async (em) => {
        const now = this.clock.now();
        const expiredBefore = new Date(now.getTime() - this.pendingPolicyTtlMilliseconds());
        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        const [candidate] = await em.execute<{ id: string }[]>(
          `select id
             from wager_transactions
            where status = 'PENDING_REFERENCE'
              and (next_reference_attempt_at <= ? or created_at <= ?)
            order by next_reference_attempt_at nulls first, created_at, id
            limit 1
            for update skip locked`,
          [now, expiredBefore],
        );
        if (!candidate) return false;
        this.metrics?.recordRetry('pending_reference');

        const record = await em.findOneOrFail(WagerTransactionRecord, { id: candidate.id });
        const transaction = wagerTransactionFromRecord(record);
        const walletRecord = await WalletService.lockWallet(em, transaction.walletId);
        if (!walletRecord) throw new WalletMissingError();
        const wallet = walletFromRecord(walletRecord);

        let reference: WagerTransaction | undefined;
        if (transaction.referenceExternalTransactionId !== undefined) {
          const referenceRecord = await em.findOne(WagerTransactionRecord, {
            providerId: transaction.providerId,
            externalTransactionId: transaction.referenceExternalTransactionId,
          });
          if (referenceRecord) reference = wagerTransactionFromRecord(referenceRecord);
        }
        const referenceAlreadyReversed = reference
          ? await this.referenceAlreadyReversed(em, reference.id)
          : false;
        const outcome = processTransaction({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed,
          now,
          newEntryId: newId,
          pendingReferencePolicy: this.pendingPolicy,
        });

        if (outcome.type === 'PROCESSED' && outcome.entry) {
          await em.nativeUpdate(
            WalletRecord,
            { id: wallet.id },
            {
              balance: wallet.balance.amount,
              version: wallet.version,
              updatedAt: wallet.updatedAt,
            },
          );
          await em.insert(LedgerEntryRecord, ledgerEntryToRecord(outcome.entry));
        }
        await em.nativeUpdate(
          WagerTransactionRecord,
          { id: transaction.id },
          wagerTransactionToRecord(transaction),
        );
        // A ID da transação dá uma correlação estável, pois o correlationId original não é persistido.
        await this.enqueueOutcomeEvents(em, transaction, wallet, outcome, transaction.id, now);
        return true;
      });
      if (!didProcess) break;
      processed += 1;
    }
    return processed;
  }

  private pendingPolicyTtlMilliseconds(): number {
    return this.pendingTtlSeconds * 1000;
  }

  private async submitInternal(
    input: SubmitWagerInput,
    inbox?: { consumerName: string; messageId: string },
  ): Promise<TransactionResult & { duplicateMessage?: boolean }> {
    const payloadHash = hashPayload(input);
    const now = this.clock.now();
    const transaction = WagerTransaction.create({
      id: newId(),
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: input.walletId,
      playerId: input.playerId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      referenceExternalTransactionId: input.referenceExternalTransactionId,
      createdAt: now,
    });

    const startedAt = performance.now();
    const result = await this.orm.em
      .fork()
      .transactional<TransactionResult & { duplicateMessage?: boolean }>(async (em) => {
        let inboxMessage: InboxMessage | undefined;
        if (inbox) {
          const receivedAt = this.clock.now();
          const insertedInbox = await em.execute<{ messageId: string }[]>(
            `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at)
           values (?, ?, ?, ?, null) on conflict do nothing returning message_id as "messageId"`,
            [inbox.consumerName, inbox.messageId, payloadHash, receivedAt],
          );
          if (insertedInbox.length === 0) {
            const existing = await em.findOne(InboxMessageRecord, {
              consumerName: inbox.consumerName,
              messageId: inbox.messageId,
            });
            if (!existing || existing.payloadHash !== payloadHash)
              throw new InboxMessageConflictError();
            return { httpStatus: 200, body: { duplicateMessage: true }, duplicateMessage: true };
          }
          inboxMessage = InboxMessage.receive({
            consumerName: inbox.consumerName,
            messageId: inbox.messageId,
            payloadHash,
            receivedAt,
          });
        }
        const finish = async (result: TransactionResult) => {
          if (inbox) {
            if (!inboxMessage) throw new Error('Inbox não foi registrado nesta transação');
            inboxMessage.markProcessed(this.clock.now());
            await em.nativeUpdate(
              InboxMessageRecord,
              { consumerName: inbox.consumerName, messageId: inbox.messageId },
              { processedAt: inboxMessage.processedAt },
            );
          }
          return result;
        };
        // Fast replay path. The unique constraints below remain the authority under races.
        const byKey = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          idempotencyKey: input.idempotencyKey,
        });
        if (byKey) return finish(this.replay(byKey, payloadHash));
        const byExternalId = await em.findOne(WagerTransactionRecord, {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
        });
        if (byExternalId) {
          if (byExternalId.idempotencyKey === input.idempotencyKey) {
            return finish(this.replay(byExternalId, payloadHash));
          }
          throw new ExternalTransactionConflictError();
        }

        await em.execute(`set local lock_timeout = '${this.lockTimeoutMs}ms'`);
        // Acquire the wallet lock before inserting the FK-backed transaction row. This avoids
        // converting a FK KEY SHARE lock to FOR UPDATE while competing requests hold the same FK.
        const walletRecord = await WalletService.lockWallet(em, input.walletId);
        if (!walletRecord) throw new WalletMissingError();
        const wallet = walletFromRecord(walletRecord);

        const inserted = await em.execute<{ id: string }[]>(
          `insert into wager_transactions (
           id, provider_id, external_transaction_id, idempotency_key, payload_hash,
           wallet_id, player_id, round_id, game_id, kind, amount, currency,
           reference_external_transaction_id, reference_transaction_id, status, failure_code,
           created_at, resolved_at, balance_snapshot, balance_snapshot_currency,
           reference_attempts, next_reference_attempt_at
         ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?, null, ?, null, null, null, 0, null)
         on conflict do nothing returning id`,
          [
            transaction.id,
            transaction.providerId,
            transaction.externalTransactionId,
            transaction.idempotencyKey,
            transaction.payloadHash,
            transaction.walletId,
            transaction.playerId,
            transaction.roundId,
            transaction.gameId,
            transaction.kind,
            transaction.money.amount,
            transaction.money.currency,
            transaction.referenceExternalTransactionId ?? null,
            transaction.status,
            transaction.createdAt,
          ],
        );
        if (inserted.length === 0) {
          const racedKey = await em.findOne(WagerTransactionRecord, {
            providerId: input.providerId,
            idempotencyKey: input.idempotencyKey,
          });
          if (racedKey) return finish(this.replay(racedKey, payloadHash));
          const racedExternal = await em.findOne(WagerTransactionRecord, {
            providerId: input.providerId,
            externalTransactionId: input.externalTransactionId,
          });
          if (racedExternal) throw new ExternalTransactionConflictError();
          throw new Error('Conflito de unicidade sem transação correspondente');
        }

        let reference: WagerTransaction | undefined;
        if (transaction.referenceExternalTransactionId !== undefined) {
          const referenceRecord = await em.findOne(WagerTransactionRecord, {
            providerId: transaction.providerId,
            externalTransactionId: transaction.referenceExternalTransactionId,
          });
          if (referenceRecord) reference = wagerTransactionFromRecord(referenceRecord);
        }
        const referenceAlreadyReversed = reference
          ? await this.referenceAlreadyReversed(em, reference.id)
          : false;
        const outcome = processTransaction({
          transaction,
          wallet,
          reference,
          referenceAlreadyReversed,
          now,
          newEntryId: newId,
          pendingReferencePolicy: this.pendingPolicy,
        });

        if (outcome.type === 'PROCESSED' && outcome.entry) {
          await em.nativeUpdate(
            WalletRecord,
            { id: wallet.id },
            {
              balance: wallet.balance.amount,
              version: wallet.version,
              updatedAt: wallet.updatedAt,
            },
          );
          await em.insert(LedgerEntryRecord, ledgerEntryToRecord(outcome.entry));
        }
        await em.nativeUpdate(
          WagerTransactionRecord,
          { id: transaction.id },
          wagerTransactionToRecord(transaction),
        );
        await this.enqueueOutcomeEvents(em, transaction, wallet, outcome, input.correlationId, now);

        return finish(resultFor(transaction, false));
      })
      .catch((error: unknown) => {
        const sqlstate = findSqlState(error);
        if (sqlstate === '55P03' || sqlstate === '40P01') {
          this.metrics?.recordLockConflict(sqlstate);
        }
        this.metrics?.observeTransactionDuration(
          inbox ? 'sqs' : 'http',
          (performance.now() - startedAt) / 1000,
        );
        throw error;
      });
    const channel = inbox ? 'sqs' : 'http';
    const status = result.duplicateMessage
      ? 'DUPLICATE_MESSAGE'
      : String(result.body.status ?? result.body.code ?? 'UNKNOWN');
    this.metrics?.recordTransaction(status, channel);
    if (result.body.idempotentReplay === true || result.duplicateMessage === true) {
      this.metrics?.recordReplay(channel);
    }
    this.metrics?.observeTransactionDuration(channel, (performance.now() - startedAt) / 1000);
    logger.info(
      {
        component: 'wager-transaction',
        channel,
        correlationId: input.correlationId,
        ...(inbox ? { messageId: inbox.messageId } : {}),
        transactionId: result.body.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        status,
      },
      'transaction handled',
    );
    return result;
  }

  async getByExternalId(providerId: string, externalTransactionId: string) {
    const record = await this.orm.em
      .fork()
      .findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    if (!record) throw new TransactionNotFoundError();
    return transactionView(wagerTransactionFromRecord(record), false);
  }

  async getById(transactionId: string) {
    const record = await this.orm.em.fork().findOne(WagerTransactionRecord, { id: transactionId });
    if (!record) throw new TransactionNotFoundError();
    return transactionView(wagerTransactionFromRecord(record), false);
  }

  private replay(record: WagerTransactionRecord, payloadHash: string): TransactionResult {
    const transaction = wagerTransactionFromRecord(record);
    if (!transaction.matchesPayload(payloadHash)) throw new IdempotencyConflictError();
    return resultFor(transaction, true);
  }

  private async referenceAlreadyReversed(em: EntityManager, referenceId: string): Promise<boolean> {
    const rows = await em.execute<{ found: boolean }[]>(
      `select exists(select 1 from wager_transactions where reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')) as found`,
      [referenceId],
    );
    return rows[0]?.found ?? false;
  }

  private async enqueueOutcomeEvents(
    em: EntityManager,
    transaction: WagerTransaction,
    wallet: Wallet,
    outcome: ReturnType<typeof processTransaction>,
    correlationId: string,
    now: Date,
  ) {
    const context = () => ({ eventId: newId(), correlationId, occurredAt: now });
    if (outcome.type === 'PROCESSED') {
      await this.enqueue(em, WagerTransactionProcessed.from(transaction, context()));
      if (outcome.entry) {
        await this.enqueue(em, WalletBalanceChanged.from(wallet, outcome.entry, context()));
      }
    } else if (outcome.type === 'REJECTED') {
      await this.enqueue(em, WagerTransactionRejected.from(transaction, context()));
    } else if (outcome.enteredNow) {
      await this.enqueue(em, WagerTransactionPendingReference.from(transaction, context()));
    }
  }

  private async enqueue(em: EntityManager, event: Parameters<typeof OutboxMessage.enqueue>[0]) {
    await em.insert(OutboxMessageRecord, outboxMessageToRecord(OutboxMessage.enqueue(event)));
  }
}

function findSqlState(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return '';
    const candidate = current as { code?: unknown; cause?: unknown; originalError?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code;
    }
    current = candidate.cause ?? candidate.originalError;
  }
  return '';
}

export class WalletMissingError extends Error {}
export class TransactionNotFoundError extends Error {}

function resultFor(transaction: WagerTransaction, idempotentReplay: boolean): TransactionResult {
  const body = transactionView(transaction, idempotentReplay);
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return { httpStatus: idempotentReplay ? 200 : 201, body };
    case WagerTransactionStatus.PendingReference:
      return { httpStatus: 202, body };
    case WagerTransactionStatus.Rejected:
      return { httpStatus: 422, body };
    case WagerTransactionStatus.Failed:
      return { httpStatus: 500, body: { code: 'TRANSACTION_FAILED', retryable: false } };
    case WagerTransactionStatus.Pending:
      throw new Error('Transação PENDING não pode sair do caso de uso');
  }
}

function transactionView(transaction: WagerTransaction, idempotentReplay: boolean) {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    idempotentReplay,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.balanceSnapshot ? { balance: transaction.balanceSnapshot.toJSON() } : {}),
    ...(transaction.referenceTransactionId
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    ...(transaction.nextReferenceAttemptAt
      ? { nextReferenceAttemptAt: transaction.nextReferenceAttemptAt.toISOString() }
      : {}),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.resolvedAt ? { resolvedAt: transaction.resolvedAt.toISOString() } : {}),
  };
}
