import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId!: string | null;
  referenceTransactionId!: string | null;
  status!: string;
  failureCode!: string | null;
  createdAt!: Date;
  resolvedAt!: Date | null;
  balanceSnapshot!: string | null;
  balanceSnapshotCurrency!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
}

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  groupKey!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { name: 'player_id', type: 'uuid' },
    currency: { type: 'char', length: 3 },
    balance: { type: 'numeric', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { name: 'created_at', type: 'timestamptz' },
    updatedAt: { name: 'updated_at', type: 'timestamptz' },
  },
});

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { name: 'provider_id', type: 'varchar', length: 255 },
    externalTransactionId: { name: 'external_transaction_id', type: 'varchar', length: 255 },
    idempotencyKey: { name: 'idempotency_key', type: 'varchar', length: 255 },
    payloadHash: { name: 'payload_hash', type: 'char', length: 64 },
    walletId: { name: 'wallet_id', type: 'uuid' },
    playerId: { name: 'player_id', type: 'uuid' },
    roundId: { name: 'round_id', type: 'varchar', length: 255 },
    gameId: { name: 'game_id', type: 'varchar', length: 255 },
    kind: { type: 'varchar', length: 16 },
    amount: { type: 'numeric', precision: 19, scale: 2 },
    currency: { type: 'char', length: 3 },
    referenceExternalTransactionId: {
      name: 'reference_external_transaction_id',
      type: 'varchar',
      length: 255,
      nullable: true,
    },
    referenceTransactionId: { name: 'reference_transaction_id', type: 'uuid', nullable: true },
    status: { type: 'varchar', length: 24 },
    failureCode: { name: 'failure_code', type: 'varchar', length: 64, nullable: true },
    createdAt: { name: 'created_at', type: 'timestamptz' },
    resolvedAt: { name: 'resolved_at', type: 'timestamptz', nullable: true },
    balanceSnapshot: {
      name: 'balance_snapshot',
      type: 'numeric',
      precision: 19,
      scale: 2,
      nullable: true,
    },
    balanceSnapshotCurrency: {
      name: 'balance_snapshot_currency',
      type: 'char',
      length: 3,
      nullable: true,
    },
    referenceAttempts: { name: 'reference_attempts', type: 'integer' },
    nextReferenceAttemptAt: {
      name: 'next_reference_attempt_at',
      type: 'timestamptz',
      nullable: true,
    },
  },
});

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { name: 'wallet_id', type: 'uuid' },
    transactionId: { name: 'transaction_id', type: 'uuid' },
    direction: { type: 'varchar', length: 6 },
    amount: { type: 'numeric', precision: 19, scale: 2 },
    currency: { type: 'char', length: 3 },
    balanceBefore: { name: 'balance_before', type: 'numeric', precision: 19, scale: 2 },
    balanceAfter: { name: 'balance_after', type: 'numeric', precision: 19, scale: 2 },
    createdAt: { name: 'created_at', type: 'timestamptz' },
  },
});

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { name: 'consumer_name', type: 'varchar', length: 100, primary: true },
    messageId: { name: 'message_id', type: 'varchar', length: 255, primary: true },
    payloadHash: { name: 'payload_hash', type: 'char', length: 64 },
    receivedAt: { name: 'received_at', type: 'timestamptz' },
    processedAt: { name: 'processed_at', type: 'timestamptz', nullable: true },
  },
});

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { name: 'aggregate_id', type: 'uuid' },
    groupKey: { name: 'group_key', type: 'uuid' },
    eventType: { name: 'event_type', type: 'varchar', length: 100 },
    payload: { type: 'json' },
    occurredAt: { name: 'occurred_at', type: 'timestamptz' },
    attempts: { type: 'integer' },
    nextAttemptAt: { name: 'next_attempt_at', type: 'timestamptz', nullable: true },
    publishedAt: { name: 'published_at', type: 'timestamptz', nullable: true },
  },
});
