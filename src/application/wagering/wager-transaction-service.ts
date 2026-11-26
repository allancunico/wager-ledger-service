import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import { hashPayload } from '../../domain/wagering/payload-hash';
import { PendingReferencePolicy } from '../../domain/wagering/pending-reference-policy';
import { processTransaction } from '../../domain/wagering/wager-rules';
import {
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
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../infrastructure/persistence/records';
import type { Clock } from '../shared/clock';
import { newId } from '../shared/ids';
import { WalletService } from '../wallets/wallet-service';

export class IdempotencyConflictError extends Error {}
export class ExternalTransactionConflictError extends Error {}

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
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
    env: Env,
  ) {
    this.lockTimeoutMs = env.LOCK_TIMEOUT_MS;
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

    return this.orm.em.fork().transactional(async (em) => {
      // Fast replay path. The unique constraints below remain the authority under races.
      const byKey = await em.findOne(WagerTransactionRecord, {
        providerId: input.providerId,
        idempotencyKey: input.idempotencyKey,
      });
      if (byKey) return this.replay(byKey, payloadHash);
      const byExternalId = await em.findOne(WagerTransactionRecord, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      });
      if (byExternalId) {
        if (byExternalId.idempotencyKey === input.idempotencyKey) {
          return this.replay(byExternalId, payloadHash);
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
        if (racedKey) return this.replay(racedKey, payloadHash);
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

      return resultFor(transaction, false);
    });
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
