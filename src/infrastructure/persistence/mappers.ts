import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord as WalletPersistenceRecord,
} from './records';

const currency = (value: string): string => value.trim();
const nullableDate = (value: Date | null): Date | undefined => value ?? undefined;
const nullableString = (value: string | null): string | undefined => value ?? undefined;

export function walletToRecord(wallet: Wallet): WalletPersistenceRecord {
  return Object.assign(new WalletPersistenceRecord(), {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.amount,
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}

export function walletFromRecord(record: WalletPersistenceRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: currency(record.currency),
    balance: Money.from({ amount: record.balance, currency: currency(record.currency) }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function wagerTransactionToRecord(tx: WagerTransaction): WagerTransactionRecord {
  return Object.assign(new WagerTransactionRecord(), {
    id: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    idempotencyKey: tx.idempotencyKey,
    payloadHash: tx.payloadHash,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    amount: tx.money.amount,
    currency: tx.money.currency,
    referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
    referenceTransactionId: tx.referenceTransactionId ?? null,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    createdAt: tx.createdAt,
    resolvedAt: tx.resolvedAt ?? null,
    balanceSnapshot: tx.balanceSnapshot?.amount ?? null,
    balanceSnapshotCurrency: tx.balanceSnapshot?.currency ?? null,
    referenceAttempts: tx.referenceAttempts,
    nextReferenceAttemptAt: tx.nextReferenceAttemptAt ?? null,
  });
}

export function wagerTransactionFromRecord(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.from({ amount: record.amount, currency: currency(record.currency) }),
    referenceExternalTransactionId: nullableString(record.referenceExternalTransactionId),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: nullableString(record.referenceTransactionId),
    failureCode: nullableString(record.failureCode) as FailureCode | undefined,
    resolvedAt: nullableDate(record.resolvedAt),
    balanceSnapshot:
      record.balanceSnapshot === null
        ? undefined
        : Money.from({
            amount: record.balanceSnapshot,
            currency: currency(record.balanceSnapshotCurrency ?? record.currency),
          }),
    referenceAttempts: record.referenceAttempts,
    nextReferenceAttemptAt: nullableDate(record.nextReferenceAttemptAt),
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return Object.assign(new LedgerEntryRecord(), {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.amount,
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.amount,
    balanceAfter: entry.balanceAfter.amount,
    createdAt: entry.createdAt,
  });
}

export function ledgerEntryFromRecord(record: LedgerEntryRecord): WalletLedgerEntry {
  const ccy = currency(record.currency);
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    direction: record.direction as LedgerDirection,
    money: Money.from({ amount: record.amount, currency: ccy }),
    balanceBefore: Money.from({ amount: record.balanceBefore, currency: ccy }),
    balanceAfter: Money.from({ amount: record.balanceAfter, currency: ccy }),
    createdAt: record.createdAt,
  });
}

export function inboxMessageToRecord(message: InboxMessage): InboxMessageRecord {
  return Object.assign(new InboxMessageRecord(), {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  });
}

export function inboxMessageFromRecord(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: nullableDate(record.processedAt),
  });
}

export function outboxMessageToRecord(message: OutboxMessage): OutboxMessageRecord {
  return Object.assign(new OutboxMessageRecord(), {
    id: message.id,
    aggregateId: message.aggregateId,
    groupKey: message.groupKey,
    eventType: message.eventType,
    payload: message.payload,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  });
}

export function outboxMessageFromRecord(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    groupKey: record.groupKey,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: nullableDate(record.nextAttemptAt),
    publishedAt: nullableDate(record.publishedAt),
  });
}
