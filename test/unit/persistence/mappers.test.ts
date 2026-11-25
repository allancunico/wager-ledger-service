import { describe, expect, test } from 'bun:test';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import {
  IntegrationEvent,
  type IntegrationEventProps,
} from '../../../src/domain/messaging/integration-event';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { FailureCode, WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction';
import {
  inboxMessageFromRecord,
  inboxMessageToRecord,
  ledgerEntryFromRecord,
  ledgerEntryToRecord,
  outboxMessageFromRecord,
  outboxMessageToRecord,
  wagerTransactionFromRecord,
  wagerTransactionToRecord,
  walletFromRecord,
  walletToRecord,
} from '../../../src/infrastructure/persistence/mappers';
import { brl, makeTx, makeWallet, T0 } from '../helpers/builders';

class TestEvent extends IntegrationEvent<{ amount: string }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  constructor(props: IntegrationEventProps<{ amount: string }>) {
    super(props);
  }

  groupKey(): string {
    return 'wallet-1';
  }
}

describe('persistence mappers', () => {
  test('wallet round-trip preserves exact numeric string and timestamps', () => {
    const wallet = makeWallet('99999999999999999.99');
    const restored = walletFromRecord(walletToRecord(wallet));
    expect(restored.balance.amount).toBe('99999999999999999.99');
    expect(restored.balance.currency).toBe('BRL');
    expect(restored.version).toBe(wallet.version);
    expect(restored.createdAt).toEqual(wallet.createdAt);
  });

  test('transaction round-trip maps database null to domain undefined', () => {
    const tx = makeTx({ kind: WagerTransactionKind.Bet });
    const record = wagerTransactionToRecord(tx);
    expect(record.referenceExternalTransactionId).toBeNull();
    expect(record.balanceSnapshot).toBeNull();
    const restored = wagerTransactionFromRecord(record);
    expect(restored.referenceExternalTransactionId).toBeUndefined();
    expect(restored.referenceTransactionId).toBeUndefined();
    expect(restored.failureCode).toBeUndefined();
    expect(restored.balanceSnapshot).toBeUndefined();
    expect(restored.money.amount).toBe(tx.money.amount);
  });

  test('transaction round-trip preserves terminal status, failure code, snapshot, and reference', () => {
    const tx = makeTx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    tx.markProcessed('internal-bet-1', T0, brl('90.00'));
    const restored = wagerTransactionFromRecord(wagerTransactionToRecord(tx));
    expect(restored.status).toBe(tx.status);
    expect(restored.referenceTransactionId).toBe('internal-bet-1');
    expect(restored.balanceSnapshot?.amount).toBe('90.00');

    const rejected = makeTx();
    rejected.reject(FailureCode.InsufficientFunds, T0, brl('0.00'));
    const rejectedAgain = wagerTransactionFromRecord(wagerTransactionToRecord(rejected));
    expect(rejectedAgain.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(rejectedAgain.balanceSnapshot?.amount).toBe('0.00');
  });

  test('ledger round-trip omits the database sequence and keeps all money exact', () => {
    const wallet = makeWallet();
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: brl('0.01'),
      at: T0,
    });
    const record = ledgerEntryToRecord(entry);
    expect('seq' in record).toBe(false);
    const restored = ledgerEntryFromRecord(record);
    expect(restored.money.amount).toBe('0.01');
    expect(restored.balanceBefore.amount).toBe('100.00');
    expect(restored.balanceAfter.amount).toBe('99.99');
    expect(restored.isBalanced()).toBe(true);
  });

  test('inbox round-trip preserves unprocessed and processed states', () => {
    const received = InboxMessage.receive({
      consumerName: 'wager-consumer',
      messageId: 'message-1',
      payloadHash: 'a'.repeat(64),
      receivedAt: T0,
    });
    const pending = inboxMessageFromRecord(inboxMessageToRecord(received));
    expect(pending.isProcessed()).toBe(false);
    received.markProcessed(new Date(T0.getTime() + 1000));
    const processed = inboxMessageFromRecord(inboxMessageToRecord(received));
    expect(processed.processedAt).toEqual(new Date(T0.getTime() + 1000));
  });

  test('outbox round-trip preserves JSON payload, attempts, and timestamps', () => {
    const event = new TestEvent({
      eventId: '0a1b2c3d-0000-4000-8000-000000000001',
      aggregateId: '0a1b2c3d-0000-4000-8000-000000000002',
      correlationId: 'corr-1',
      occurredAt: T0,
      data: { amount: '12.34' },
    });
    const message = OutboxMessage.enqueue(event);
    message.scheduleRetry(T0, { baseSeconds: 5, maxSeconds: 20, jitterRatio: 0 }, () => 0.5);
    const restored = outboxMessageFromRecord(outboxMessageToRecord(message));
    expect(restored.id).toBe(message.id);
    expect(restored.payload).toEqual(message.payload);
    expect(restored.attempts).toBe(1);
    expect(restored.nextAttemptAt).toEqual(new Date(T0.getTime() + 5000));
  });
});
