import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InvalidInputError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  MissingReferenceError,
  OpeningNotAllowedError,
} from '../../../src/domain/shared/errors';
import { Money } from '../../../src/domain/shared/money';
import {
  FailureCode,
  MAX_IDENTIFIER_LENGTH,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import { LedgerDirection } from '../../../src/domain/wallet/wallet-ledger-entry';
import { brl, makeInStatus, makeProcessed, makeTx, T0, usd } from '../helpers/builders';

const T1 = new Date('2026-01-01T00:01:00.000Z');
const { Bet, Win, Loss, Refund, Rollback, Opening } = WagerTransactionKind;
const S = WagerTransactionStatus;

describe('WagerTransaction.create', () => {
  test('nasce em PENDING, sem referência resolvida, sem falha e sem snapshot', () => {
    const tx = makeTx({ kind: Bet });
    expect(tx.status).toBe(S.Pending);
    expect(tx.referenceTransactionId).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.balanceSnapshot).toBeUndefined();
    expect(tx.resolvedAt).toBeUndefined();
    expect(tx.isTerminal()).toBe(false);
    expect(tx.referenceAttempts).toBe(0);
  });

  test('OPENING é interno e não pode ser submetido', () => {
    expect(() => makeTx({ kind: Opening })).toThrow(OpeningNotAllowedError);
  });

  test.each([Refund, Rollback])('%s exige referenceExternalTransactionId', (kind) => {
    expect(() => makeTx({ kind })).toThrow(MissingReferenceError);
  });

  test.each([Refund, Rollback])('%s aceita referência', (kind) => {
    const tx = makeTx({ kind, referenceExternalTransactionId: 'bet-1' });
    expect(tx.referenceExternalTransactionId).toBe('bet-1');
    expect(tx.requiresReference()).toBe(true);
  });

  test('WIN e LOSS aceitam referência opcional', () => {
    expect(makeTx({ kind: Win }).referenceExternalTransactionId).toBeUndefined();
    expect(makeTx({ kind: Win, referenceExternalTransactionId: 'bet-1' }).requiresReference()).toBe(
      false,
    );
    expect(
      makeTx({ kind: Loss, referenceExternalTransactionId: 'bet-1' })
        .referenceExternalTransactionId,
    ).toBe('bet-1');
  });

  test('BET não aceita referência', () => {
    expect(() => makeTx({ kind: Bet, referenceExternalTransactionId: 'x' })).toThrow(
      InvalidInputError,
    );
  });

  test('uma transação não pode referenciar a si mesma', () => {
    expect(() =>
      makeTx({
        kind: Refund,
        externalTransactionId: 'same',
        referenceExternalTransactionId: 'same',
      }),
    ).toThrow(InvalidInputError);
  });

  test('valor zero é recusado (CHECK amount > 0 também no banco)', () => {
    expect(() => makeTx({ money: Money.zero('BRL') })).toThrow(InvalidMoneyError);
  });

  test.each(['providerId', 'externalTransactionId', 'roundId', 'gameId', 'playerId', 'walletId'])(
    'recusa %s vazio',
    (field) => {
      expect(() => makeTx({ [field]: '' })).toThrow(InvalidInputError);
    },
  );

  test('recusa identificadores acima de 255 caracteres (a coluna não comportaria)', () => {
    expect(() => makeTx({ externalTransactionId: 'x'.repeat(MAX_IDENTIFIER_LENGTH + 1) })).toThrow(
      InvalidInputError,
    );
    expect(() => makeTx({ roundId: 'x'.repeat(MAX_IDENTIFIER_LENGTH) })).not.toThrow();
  });

  test('recusa kind desconhecido', () => {
    expect(() => makeTx({ kind: 'JACKPOT' as WagerTransactionKind })).toThrow(InvalidInputError);
  });
});

describe('WagerTransaction.opening', () => {
  test('nasce PROCESSED, interna, com snapshot do saldo', () => {
    const tx = WagerTransaction.opening({
      id: 'tx-open',
      walletId: 'w1',
      playerId: 'p1',
      money: brl('1000.00'),
      payloadHash: 'h',
      createdAt: T0,
    });
    expect(tx.kind).toBe(Opening);
    expect(tx.status).toBe(S.Processed);
    expect(tx.providerId).toBe('system');
    expect(tx.idempotencyKey).toBe('opening:w1');
    expect(tx.balanceSnapshot?.amount).toBe('1000.00');
    expect(tx.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(tx.isTerminal()).toBe(true);
  });

  test('recusa valor zero', () => {
    expect(() =>
      WagerTransaction.opening({
        id: 't',
        walletId: 'w',
        playerId: 'p',
        money: Money.zero('BRL'),
        payloadHash: 'h',
        createdAt: T0,
      }),
    ).toThrow(InvalidMoneyError);
  });
});

describe('WagerTransaction: máquina de estados', () => {
  test('PENDING → PROCESSED registra referência, instante e saldo observado', () => {
    const tx = makeTx({ kind: Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markProcessed('internal-ref', T1, brl('90.00'));
    expect(tx.status).toBe(S.Processed);
    expect(tx.referenceTransactionId).toBe('internal-ref');
    expect(tx.resolvedAt?.getTime()).toBe(T1.getTime());
    expect(tx.balanceSnapshot?.amount).toBe('90.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → REJECTED guarda failureCode e saldo observado (replay devolve a mesma rejeição)', () => {
    const tx = makeTx();
    tx.reject(FailureCode.InsufficientFunds, T1, brl('20.00'));
    expect(tx.status).toBe(S.Rejected);
    expect(tx.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(tx.balanceSnapshot?.amount).toBe('20.00');
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → FAILED é terminal e auditável', () => {
    const tx = makeTx();
    tx.fail(FailureCode.ProcessingAttemptsExhausted, T1);
    expect(tx.status).toBe(S.Failed);
    expect(tx.failureCode).toBe(FailureCode.ProcessingAttemptsExhausted);
    expect(tx.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE agenda a próxima tentativa e zera as tentativas', () => {
    const tx = makeTx({ kind: Refund, referenceExternalTransactionId: 'bet-1' });
    tx.markPendingReference(T1);
    expect(tx.status).toBe(S.PendingReference);
    expect(tx.referenceAttempts).toBe(0);
    expect(tx.nextReferenceAttemptAt?.getTime()).toBe(T1.getTime());
    expect(tx.isTerminal()).toBe(false);
  });

  test('PENDING_REFERENCE → PROCESSED / REJECTED / FAILED são permitidos', () => {
    for (const finish of [
      (t: WagerTransaction) => t.markProcessed('ref', T1, brl('1.00')),
      (t: WagerTransaction) => t.reject(FailureCode.ReferenceNotFound, T1, brl('1.00')),
      (t: WagerTransaction) => t.fail(FailureCode.ProcessingAttemptsExhausted, T1),
    ]) {
      const tx = makeTx({ kind: Refund, referenceExternalTransactionId: 'bet-1' });
      tx.markPendingReference(T1);
      finish(tx);
      expect(tx.isTerminal()).toBe(true);
      expect(tx.nextReferenceAttemptAt).toBeUndefined();
    }
  });

  test('recordReferenceRetry incrementa as tentativas e reagenda (só em PENDING_REFERENCE)', () => {
    const tx = makeTx({ kind: Rollback, referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.recordReferenceRetry(T1)).toThrow(InvalidTransactionStateError);
    tx.markPendingReference(T0);
    tx.recordReferenceRetry(T1);
    tx.recordReferenceRetry(new Date('2026-01-01T00:02:00.000Z'));
    expect(tx.referenceAttempts).toBe(2);
    expect(tx.nextReferenceAttemptAt?.toISOString()).toBe('2026-01-01T00:02:00.000Z');
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, T1, brl('1.00'))],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds, T1)],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.ProcessingAttemptsExhausted, T1)],
  ])('estado terminal %s não aceita nenhuma transição', (_name, reachTerminal) => {
    const tx = makeTx();
    reachTerminal(tx);
    const before = { status: tx.status, code: tx.failureCode, snapshot: tx.balanceSnapshot };

    expect(() => tx.markProcessed(undefined, T1, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.reject(FailureCode.InsufficientFunds, T1)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.fail(FailureCode.ProcessingAttemptsExhausted, T1)).toThrow(
      InvalidTransactionStateError,
    );
    expect(() => tx.markPendingReference(T1)).toThrow(InvalidTransactionStateError);
    expect(() => tx.recordReferenceRetry(T1)).toThrow(InvalidTransactionStateError);

    expect({ status: tx.status, code: tx.failureCode, snapshot: tx.balanceSnapshot }).toEqual(
      before,
    );
  });

  test('markPendingReference só a partir de PENDING, e só com referência a esperar', () => {
    const waiting = makeInStatus(S.PendingReference, {
      kind: Refund,
      referenceExternalTransactionId: 'b',
    });
    expect(() => waiting.markPendingReference(T1)).toThrow(InvalidTransactionStateError);
    expect(() => makeTx({ kind: Bet }).markPendingReference(T1)).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('reversão não pode ser processada sem o id interno da referência', () => {
    const tx = makeTx({ kind: Refund, referenceExternalTransactionId: 'bet-1' });
    expect(() => tx.markProcessed(undefined, T1, brl('1.00'))).toThrow(
      InvalidTransactionStateError,
    );
    expect(tx.status).toBe(S.Pending);
  });

  test('o saldo observado precisa estar na moeda da transação', () => {
    const tx = makeTx();
    expect(() => tx.markProcessed(undefined, T1, usd('1.00'))).toThrow(CurrencyMismatchError);
    expect(() => tx.reject(FailureCode.InsufficientFunds, T1, usd('1.00'))).toThrow(
      CurrencyMismatchError,
    );
    expect(tx.status).toBe(S.Pending);
  });

  test('rehydrate reconstrói qualquer estado sem revalidar (inclusive terminal)', () => {
    const rejected = makeInStatus(S.Rejected, { failureCode: FailureCode.AmountMismatch });
    expect(rejected.status).toBe(S.Rejected);
    expect(rejected.failureCode).toBe(FailureCode.AmountMismatch);
    expect(() => rejected.reject(FailureCode.InsufficientFunds, T1)).toThrow(
      InvalidTransactionStateError,
    );
  });
});

describe('WagerTransaction: consultas de domínio', () => {
  test('affectsBalance é falso só para LOSS', () => {
    expect(makeTx({ kind: Loss }).affectsBalance()).toBe(false);
    for (const kind of [Bet, Win]) expect(makeTx({ kind }).affectsBalance()).toBe(true);
    for (const kind of [Refund, Rollback]) {
      expect(makeTx({ kind, referenceExternalTransactionId: 'r' }).affectsBalance()).toBe(true);
    }
  });

  test('requiresReference é verdadeiro só para REFUND e ROLLBACK', () => {
    expect(makeTx({ kind: Bet }).requiresReference()).toBe(false);
    expect(makeTx({ kind: Win }).requiresReference()).toBe(false);
    expect(makeTx({ kind: Loss }).requiresReference()).toBe(false);
  });

  test('matchesPayload compara o hash (conflito de idempotência)', () => {
    const tx = makeTx();
    expect(tx.matchesPayload(tx.payloadHash)).toBe(true);
    expect(tx.matchesPayload('outro-hash')).toBe(false);
  });

  test('isDueForReferenceRetry respeita o agendamento e o estado', () => {
    const tx = makeTx({ kind: Refund, referenceExternalTransactionId: 'b' });
    expect(tx.isDueForReferenceRetry(T1)).toBe(false);
    tx.markPendingReference(T1);
    expect(tx.isDueForReferenceRetry(new Date(T1.getTime() - 1))).toBe(false);
    expect(tx.isDueForReferenceRetry(T1)).toBe(true);
    tx.reject(FailureCode.ReferenceNotFound, T1);
    expect(tx.isDueForReferenceRetry(T1)).toBe(false);
  });
});

describe('WagerTransaction.ledgerDirectionFor', () => {
  test('BET debita; WIN e REFUND creditam', () => {
    expect(makeTx({ kind: Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(makeTx({ kind: Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(makeTx({ kind: Refund, referenceExternalTransactionId: 'b' }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
  });

  test('LOSS não tem direção de lançamento', () => {
    expect(() => makeTx({ kind: Loss }).ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
  });

  test('ROLLBACK é o inverso da direção da referência', () => {
    const rollback = (): WagerTransaction =>
      makeTx({ kind: Rollback, referenceExternalTransactionId: 'r' });
    expect(rollback().ledgerDirectionFor(makeProcessed({ kind: Bet }))).toBe(
      LedgerDirection.Credit,
    );
    expect(rollback().ledgerDirectionFor(makeProcessed({ kind: Win }))).toBe(LedgerDirection.Debit);
    expect(
      rollback().ledgerDirectionFor(
        makeProcessed({ kind: Refund, referenceExternalTransactionId: 'b' }),
      ),
    ).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência, ou de LOSS/ROLLBACK, é erro de programação', () => {
    const rollback = (): WagerTransaction =>
      makeTx({ kind: Rollback, referenceExternalTransactionId: 'r' });
    expect(() => rollback().ledgerDirectionFor()).toThrow(InvalidTransactionStateError);
    expect(() => rollback().ledgerDirectionFor(makeProcessed({ kind: Loss }))).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      rollback().ledgerDirectionFor(
        makeProcessed({ kind: Rollback, referenceExternalTransactionId: 'x' }),
      ),
    ).toThrow(InvalidTransactionStateError);
  });
});
