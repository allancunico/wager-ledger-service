import { describe, expect, test } from 'bun:test';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../../src/domain/messaging/events';
import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import type { EventContext } from '../../../src/domain/messaging/integration-event';
import {
  DEFAULT_OUTBOX_BACKOFF,
  OutboxMessage,
} from '../../../src/domain/messaging/outbox-message';
import {
  InvalidInputError,
  InvalidMessageStateError,
  InvalidTransactionStateError,
} from '../../../src/domain/shared/errors';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { brl, makeInStatus, makeProcessed, makeTx, makeWallet, T0 } from '../helpers/builders';

const ctx: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'cause-1',
  occurredAt: new Date('2026-07-29T15:00:00.000Z'),
};
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('eventos de integração: envelope', () => {
  const processed = () => {
    const tx = makeTx({ kind: WagerTransactionKind.Bet, money: brl('25.00') });
    tx.markProcessed(undefined, T0, brl('975.00'));
    return tx;
  };

  test('toJSON expõe o envelope completo, com occurredAt ISO-8601 e versão no tipo', () => {
    const tx = processed();
    const event = WagerTransactionProcessed.from(tx, ctx);
    const json = event.toJSON();
    expect(json.eventId).toBe('event-1');
    expect(json.eventType).toBe('WagerTransactionProcessed');
    expect(json.version).toBe(1);
    expect(json.aggregateId).toBe(tx.id); // em eventos de transação o agregado é a transação
    expect(json.correlationId).toBe('corr-1');
    expect(json.causationId).toBe('cause-1');
    expect(json.occurredAt).toBe('2026-07-29T15:00:00.000Z');
    expect(json.data.balance).toEqual({ amount: '975.00', currency: 'BRL' });
  });

  test('causationId ausente não aparece no envelope', () => {
    const event = WagerTransactionProcessed.from(processed(), { ...ctx, causationId: undefined });
    expect('causationId' in event.toJSON()).toBe(false);
  });

  test('data só tem JSON: dinheiro como string decimal, nunca instância de Money', () => {
    const json = JSON.parse(JSON.stringify(WagerTransactionProcessed.from(processed(), ctx)));
    expect(json.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(typeof json.data.money.amount).toBe('string');
    expect(typeof json.data.balance.amount).toBe('string');
  });

  test('o evento é imutável: data congelada e occurredAt sem aliasing', () => {
    const occurredAt = new Date(ctx.occurredAt.getTime());
    const event = WagerTransactionProcessed.from(processed(), { ...ctx, occurredAt });
    expect(Object.isFrozen(event.data)).toBe(true);
    expect(Object.isFrozen(event.data.money)).toBe(true);
    expect(() => {
      (event.data as { walletId: string }).walletId = 'x';
    }).toThrow();
    occurredAt.setUTCFullYear(1999);
    expect(event.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
  });

  test('toda subclasse usa a wallet como chave de ordenação', () => {
    expect(WagerTransactionProcessed.from(processed(), ctx).groupKey()).toBe('wallet-1');
  });
});

describe('WagerTransactionProcessed', () => {
  test('LOSS também gera o evento (aplicada, sem mover saldo)', () => {
    const loss = makeTx({ kind: WagerTransactionKind.Loss });
    loss.markProcessed(undefined, T0, brl('100.00'));
    const event = WagerTransactionProcessed.from(loss, ctx);
    expect(event.data.kind).toBe(WagerTransactionKind.Loss);
    expect(event.data.balance.amount).toBe('100.00');
  });

  test('reversão carrega o id interno da referência', () => {
    const refund = makeTx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    refund.markProcessed('internal-bet-id', T0, brl('100.00'));
    expect(WagerTransactionProcessed.from(refund, ctx).data.referenceTransactionId).toBe(
      'internal-bet-id',
    );
  });

  test('exige transação PROCESSED', () => {
    expect(() => WagerTransactionProcessed.from(makeTx(), ctx)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionRejected', () => {
  test('carrega failureCode e o saldo observado', () => {
    const tx = makeTx({ money: brl('50.00') });
    tx.reject(FailureCode.InsufficientFunds, T0, brl('10.00'));
    const event = WagerTransactionRejected.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.data.balance).toEqual({ amount: '10.00', currency: 'BRL' });
  });

  test('rejeição sem saldo observado omite o campo', () => {
    const tx = makeTx();
    tx.reject(FailureCode.ReferenceNotFound, T0);
    expect('balance' in WagerTransactionRejected.from(tx, ctx).data).toBe(false);
  });

  test('exige transação REJECTED', () => {
    expect(() => WagerTransactionRejected.from(makeTx(), ctx)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransactionPendingReference', () => {
  test('carrega a referência esperada', () => {
    const tx = makeTx({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'bet-1',
    });
    tx.markPendingReference(at(5));
    const event = WagerTransactionPendingReference.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('bet-1');
  });

  test('exige PENDING_REFERENCE', () => {
    expect(() => WagerTransactionPendingReference.from(makeTx(), ctx)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      WagerTransactionPendingReference.from(
        makeInStatus(WagerTransactionStatus.Rejected, {
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: 'b',
        }),
        ctx,
      ),
    ).toThrow(InvalidTransactionStateError);
  });
});

describe('WalletBalanceChanged', () => {
  test('nasce de um lançamento e carrega o saldo antes e depois e a version da wallet', () => {
    const wallet = makeWallet('100.00');
    const entry = wallet.debit({
      entryId: 'e1',
      transactionId: 'tx-9',
      money: brl('25.00'),
      at: T0,
    });
    const event = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.groupKey()).toBe('wallet-1');
    expect(event.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-9',
      direction: LedgerDirection.Debit,
      money: { amount: '25.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '75.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  test('recusa lançamento de outra wallet ou depois de nova movimentação', () => {
    const wallet = makeWallet('100.00');
    const entry = wallet.debit({
      entryId: 'e1',
      transactionId: 'tx-1',
      money: brl('10.00'),
      at: T0,
    });
    wallet.credit({ entryId: 'e2', transactionId: 'tx-2', money: brl('1.00'), at: T0 });
    expect(() => WalletBalanceChanged.from(wallet, entry, ctx)).toThrow(
      InvalidTransactionStateError,
    );

    const other = Wallet.rehydrate({
      id: 'wallet-2',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('90.00'),
      version: 1,
      createdAt: T0,
      updatedAt: T0,
    });
    expect(() => WalletBalanceChanged.from(other, entry, ctx)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('OutboxMessage', () => {
  const event = () =>
    WagerTransactionProcessed.from(makeProcessed({ kind: WagerTransactionKind.Bet }), ctx);

  test('enqueue usa o eventId como id e a wallet como groupKey, com payload só de JSON', () => {
    const e = event();
    const outbox = OutboxMessage.enqueue(e);
    expect(outbox.id).toBe('event-1');
    expect(outbox.aggregateId).toBe(e.aggregateId);
    expect(outbox.groupKey).toBe('wallet-1');
    expect(outbox.eventType).toBe('WagerTransactionProcessed');
    expect(outbox.payload).toEqual(JSON.parse(JSON.stringify(e)));
    expect(outbox.attempts).toBe(0);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.occurredAt.toISOString()).toBe('2026-07-29T15:00:00.000Z');
  });

  test('o payload é imutável e desacoplado do evento', () => {
    const outbox = OutboxMessage.enqueue(event());
    expect(Object.isFrozen(outbox.payload)).toBe(true);
    expect(() => {
      (outbox.payload as Record<string, unknown>).eventType = 'x';
    }).toThrow();
  });

  test('recém-enfileirado vence imediatamente', () => {
    const outbox = OutboxMessage.enqueue(event());
    expect(outbox.isDue(T0)).toBe(true);
    expect(outbox.nextAttemptAt).toBeUndefined();
  });

  test('markPublished tira da fila; publicar duas vezes é erro', () => {
    const outbox = OutboxMessage.enqueue(event());
    outbox.markPublished(at(1));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(at(100))).toBe(false);
    expect(outbox.publishedAt?.getTime()).toBe(at(1).getTime());
    expect(() => outbox.markPublished(at(2))).toThrow(InvalidMessageStateError);
    expect(() => outbox.scheduleRetry(at(2))).toThrow(InvalidMessageStateError);
  });

  test('scheduleRetry incrementa attempts, adia a próxima tentativa e só vence depois dela', () => {
    const outbox = OutboxMessage.enqueue(event());
    outbox.scheduleRetry(T0, { baseSeconds: 1, maxSeconds: 300, jitterRatio: 0 });
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at(1).getTime());
    expect(outbox.isDue(new Date(at(1).getTime() - 1))).toBe(false);
    expect(outbox.isDue(at(1))).toBe(true);

    outbox.scheduleRetry(at(1), { baseSeconds: 1, maxSeconds: 300, jitterRatio: 0 });
    expect(outbox.attempts).toBe(2);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at(1 + 2).getTime());
  });

  test('sem estado terminal: mesmo com 1000 falhas continua pendente, com atraso limitado ao teto', () => {
    const outbox = OutboxMessage.enqueue(event());
    let now = T0;
    for (let i = 0; i < 1000; i++) {
      outbox.scheduleRetry(now, DEFAULT_OUTBOX_BACKOFF, () => 0.5);
      const next = outbox.nextAttemptAt as Date;
      expect(next.getTime() - now.getTime()).toBeLessThanOrEqual(
        DEFAULT_OUTBOX_BACKOFF.maxSeconds * 1000,
      );
      now = next;
    }
    expect(outbox.attempts).toBe(1000);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(new Date(now.getTime() + 1))).toBe(true);
  });

  test('rehydrate reconstrói o estado persistido', () => {
    const outbox = OutboxMessage.rehydrate({
      id: 'e9',
      aggregateId: 'a1',
      groupKey: 'wallet-1',
      eventType: 'WalletBalanceChanged',
      payload: { eventId: 'e9' },
      occurredAt: T0,
      attempts: 4,
      nextAttemptAt: at(30),
    });
    expect(outbox.attempts).toBe(4);
    expect(outbox.isDue(at(29))).toBe(false);
    expect(outbox.isDue(at(30))).toBe(true);
  });
});

describe('InboxMessage', () => {
  const props = {
    messageId: 'msg-123',
    consumerName: 'wager-transactions',
    payloadHash: 'h',
    receivedAt: T0,
  };

  test('receive nasce não processada', () => {
    const inbox = InboxMessage.receive(props);
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
    expect(inbox.messageId).toBe('msg-123');
    expect(inbox.consumerName).toBe('wager-transactions');
  });

  test('markProcessed registra o instante; marcar de novo é erro', () => {
    const inbox = InboxMessage.receive(props);
    inbox.markProcessed(at(3));
    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.getTime()).toBe(at(3).getTime());
    expect(() => inbox.markProcessed(at(4))).toThrow(InvalidMessageStateError);
  });

  test.each(['messageId', 'consumerName', 'payloadHash'])('recusa %s vazio', (field) => {
    expect(() => InboxMessage.receive({ ...props, [field]: '' })).toThrow(InvalidInputError);
  });

  test('rehydrate respeita um estado já processado', () => {
    const inbox = InboxMessage.rehydrate({ ...props, processedAt: at(1) });
    expect(inbox.isProcessed()).toBe(true);
    expect(() => inbox.markProcessed(at(2))).toThrow(InvalidMessageStateError);
  });
});
