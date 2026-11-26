import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/domain/shared/errors';
import { Money } from '../../../src/domain/shared/money';
import {
  type Decision,
  evaluate,
  processTransaction,
} from '../../../src/domain/wagering/wager-rules';
import {
  FailureCode,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet/wallet';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';
import {
  brl,
  makeInStatus,
  makeProcessed,
  makeTx,
  makeWallet,
  noRandom,
  policy,
  T0,
  usd,
} from '../helpers/builders';

const { Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const S = WagerTransactionStatus;
const REF = 'bet-1';

const reject = (code: FailureCode): Decision => ({ type: 'REJECT', code });
const apply = (direction: LedgerDirection | null): Decision => ({ type: 'APPLY', direction });
const pending = (reason: 'REFERENCE_MISSING' | 'REFERENCE_PENDING'): Decision => ({
  type: 'PENDING_REFERENCE',
  reason,
});

/** Referência já processada, com o mesmo contexto da transação dependente. */
const processedRef = (kind: WagerTransactionKind = Bet, amount = '10.00') =>
  makeProcessed({
    kind,
    externalTransactionId: REF,
    money: brl(amount),
    // WIN/REFUND/ROLLBACK como referência precisam de contexto próprio válido
    ...(kind === Refund || kind === Rollback ? { referenceExternalTransactionId: 'origin' } : {}),
  });

describe('evaluate: BET', () => {
  test('com saldo suficiente, debita', () => {
    expect(
      evaluate({
        transaction: makeTx({ kind: Bet }),
        wallet: makeWallet('100.00'),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(LedgerDirection.Debit));
  });

  test('saldo exatamente igual ao valor é permitido; um centavo a menos é INSUFFICIENT_FUNDS', () => {
    const tx = () => makeTx({ kind: Bet, money: brl('80.00') });
    expect(
      evaluate({ transaction: tx(), wallet: makeWallet('80.00'), referenceAlreadyReversed: false }),
    ).toEqual(apply(LedgerDirection.Debit));
    expect(
      evaluate({ transaction: tx(), wallet: makeWallet('79.99'), referenceAlreadyReversed: false }),
    ).toEqual(reject(FailureCode.InsufficientFunds));
  });
});

describe('evaluate: WIN e LOSS', () => {
  const wallet = () => makeWallet('100.00');

  test('WIN credita e LOSS não move saldo', () => {
    expect(
      evaluate({
        transaction: makeTx({ kind: Win }),
        wallet: wallet(),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(LedgerDirection.Credit));
    expect(
      evaluate({
        transaction: makeTx({ kind: Loss }),
        wallet: wallet(),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(null));
  });

  test('WIN com referência a uma BET processada credita, e o valor pode diferir da aposta', () => {
    const win = makeTx({ kind: Win, referenceExternalTransactionId: REF, money: brl('250.00') });
    expect(
      evaluate({
        transaction: win,
        wallet: wallet(),
        reference: processedRef(Bet, '10.00'),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(LedgerDirection.Credit));
  });

  test('WIN com referência ausente fica pendente, como as demais', () => {
    const win = makeTx({ kind: Win, referenceExternalTransactionId: REF });
    expect(
      evaluate({ transaction: win, wallet: wallet(), referenceAlreadyReversed: false }),
    ).toEqual(pending('REFERENCE_MISSING'));
  });

  test('WIN e LOSS só referenciam BET', () => {
    for (const kind of [Win, Loss]) {
      const tx = makeTx({ kind, referenceExternalTransactionId: REF });
      expect(
        evaluate({
          transaction: tx,
          wallet: wallet(),
          reference: processedRef(Win),
          referenceAlreadyReversed: false,
        }),
      ).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
    }
  });

  test('a BET referenciada por um WIN já revertida não impede o WIN (WIN não é reversão)', () => {
    const win = makeTx({ kind: Win, referenceExternalTransactionId: REF });
    expect(
      evaluate({
        transaction: win,
        wallet: wallet(),
        reference: processedRef(Bet),
        referenceAlreadyReversed: true,
      }),
    ).toEqual(apply(LedgerDirection.Credit));
  });
});

describe('evaluate: REFUND', () => {
  const refund = (amount = '10.00') =>
    makeTx({ kind: Refund, referenceExternalTransactionId: REF, money: brl(amount) });
  const wallet = () => makeWallet('100.00');

  test('de uma BET processada, de valor igual, credita', () => {
    expect(
      evaluate({
        transaction: refund(),
        wallet: wallet(),
        reference: processedRef(Bet),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(LedgerDirection.Credit));
  });

  test('referência ausente → espera (REFERENCE_MISSING)', () => {
    expect(
      evaluate({ transaction: refund(), wallet: wallet(), referenceAlreadyReversed: false }),
    ).toEqual(pending('REFERENCE_MISSING'));
  });

  test.each([S.Pending, S.PendingReference])(
    'referência %s → espera (REFERENCE_PENDING)',
    (status) => {
      const reference = makeInStatus(status, { kind: Bet, externalTransactionId: REF });
      expect(
        evaluate({
          transaction: refund(),
          wallet: wallet(),
          reference,
          referenceAlreadyReversed: false,
        }),
      ).toEqual(pending('REFERENCE_PENDING'));
    },
  );

  test.each([S.Rejected, S.Failed])('referência %s → REFERENCE_NOT_PROCESSED', (status) => {
    const reference = makeInStatus(status, { kind: Bet, externalTransactionId: REF });
    expect(
      evaluate({
        transaction: refund(),
        wallet: wallet(),
        reference,
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceNotProcessed));
  });

  test.each([Win, Loss, Refund])('só referencia BET: %s → REFERENCE_KIND_NOT_ALLOWED', (kind) => {
    expect(
      evaluate({
        transaction: refund(),
        wallet: wallet(),
        reference: processedRef(kind),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
  });

  test('valor diferente do da referência → AMOUNT_MISMATCH (reversão parcial fora de escopo)', () => {
    for (const amount of ['9.99', '10.01', '5.00']) {
      expect(
        evaluate({
          transaction: refund(amount),
          wallet: wallet(),
          reference: processedRef(Bet, '10.00'),
          referenceAlreadyReversed: false,
        }),
      ).toEqual(reject(FailureCode.AmountMismatch));
    }
  });

  test('referência já revertida → REFERENCE_ALREADY_REVERSED', () => {
    expect(
      evaluate({
        transaction: refund(),
        wallet: wallet(),
        reference: processedRef(Bet),
        referenceAlreadyReversed: true,
      }),
    ).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
  });

  test.each([
    ['player', { playerId: 'player-9' }],
    ['wallet', { walletId: 'wallet-9' }],
    ['rodada', { roundId: 'round-9' }],
    ['provider', { providerId: 'provider-z' }],
  ])('referência de outro %s → REFERENCE_MISMATCH', (_what, overrides) => {
    const reference = makeProcessed({
      kind: Bet,
      externalTransactionId: REF,
      money: brl('10.00'),
      ...overrides,
    });
    expect(
      evaluate({
        transaction: refund(),
        wallet: wallet(),
        reference,
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceMismatch));
  });

  test('referência em outra moeda → CURRENCY_MISMATCH', () => {
    const reference = makeProcessed({ kind: Bet, externalTransactionId: REF, money: usd('10.00') });
    expect(
      evaluate({
        transaction: refund(),
        wallet: wallet(),
        reference,
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.CurrencyMismatch));
  });
});

describe('evaluate: ROLLBACK', () => {
  const rollback = (amount = '10.00') =>
    makeTx({ kind: Rollback, referenceExternalTransactionId: REF, money: brl(amount) });

  test('de BET credita de volta (inverso do débito)', () => {
    expect(
      evaluate({
        transaction: rollback(),
        wallet: makeWallet('0.00'),
        reference: processedRef(Bet),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(LedgerDirection.Credit));
  });

  test.each([Win, Refund])('de %s debita (inverso do crédito)', (kind) => {
    expect(
      evaluate({
        transaction: rollback(),
        wallet: makeWallet('10.00'),
        reference: processedRef(kind),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(apply(LedgerDirection.Debit));
  });

  test.each([Win, Refund])(
    'de %s sem saldo para o débito → REVERSAL_WOULD_OVERDRAW, distinto de INSUFFICIENT_FUNDS',
    (kind) => {
      const decision = evaluate({
        transaction: rollback(),
        wallet: makeWallet('9.99'),
        reference: processedRef(kind),
        referenceAlreadyReversed: false,
      });
      expect(decision).toEqual(reject(FailureCode.ReversalWouldOverdraw));
      expect(FailureCode.ReversalWouldOverdraw).not.toBe(FailureCode.InsufficientFunds);
    },
  );

  test.each([Loss, Rollback])('%s não é reversível → REFERENCE_KIND_NOT_ALLOWED', (kind) => {
    expect(
      evaluate({
        transaction: rollback(),
        wallet: makeWallet('100.00'),
        reference: processedRef(kind),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
  });

  test('referência já revertida pelo mesmo tipo → REFERENCE_ALREADY_REVERSED', () => {
    expect(
      evaluate({
        transaction: rollback(),
        wallet: makeWallet('100.00'),
        reference: processedRef(Bet),
        referenceAlreadyReversed: true,
      }),
    ).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
  });

  test('valor diferente → AMOUNT_MISMATCH', () => {
    expect(
      evaluate({
        transaction: rollback('10.01'),
        wallet: makeWallet('100.00'),
        reference: processedRef(Bet, '10.00'),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.AmountMismatch));
  });
});

describe('evaluate: wallet e moeda', () => {
  test('wallet de outro player → WALLET_PLAYER_MISMATCH', () => {
    expect(
      evaluate({
        transaction: makeTx({ kind: Bet }),
        wallet: makeWallet('100.00', { playerId: 'someone-else' }),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.WalletPlayerMismatch));
  });

  test('moeda da transação diferente da wallet → CURRENCY_MISMATCH', () => {
    expect(
      evaluate({
        transaction: makeTx({ kind: Bet, money: usd('10.00') }),
        wallet: makeWallet('100.00'),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.CurrencyMismatch));
  });
});

describe('evaluate: precedência entre regras (a ordem decide qual failureCode o provedor recebe)', () => {
  test('player da wallet tem precedência sobre a moeda', () => {
    const tx = makeTx({ kind: Bet, money: usd('10.00') });
    expect(
      evaluate({
        transaction: tx,
        wallet: makeWallet('100.00', { playerId: 'x' }),
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.WalletPlayerMismatch));
  });

  test('referência incompatível é rejeitada na hora, mesmo com a referência ainda pendente', () => {
    const wrongKind = makeInStatus(S.PendingReference, { kind: Win, externalTransactionId: REF });
    const refund = makeTx({ kind: Refund, referenceExternalTransactionId: REF });
    expect(
      evaluate({
        transaction: refund,
        wallet: makeWallet('100.00'),
        reference: wrongKind,
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceKindNotAllowed));

    const otherWallet = makeInStatus(S.PendingReference, {
      kind: Bet,
      externalTransactionId: REF,
      walletId: 'w-9',
    });
    expect(
      evaluate({
        transaction: refund,
        wallet: makeWallet('100.00'),
        reference: otherWallet,
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceMismatch));
  });

  test('tipo de referência proibido tem precedência sobre o estado dela', () => {
    const rejectedWin = makeInStatus(S.Rejected, { kind: Win, externalTransactionId: REF });
    const refund = makeTx({ kind: Refund, referenceExternalTransactionId: REF });
    expect(
      evaluate({
        transaction: refund,
        wallet: makeWallet('100.00'),
        reference: rejectedWin,
        referenceAlreadyReversed: false,
      }),
    ).toEqual(reject(FailureCode.ReferenceKindNotAllowed));
  });

  test('valor divergente tem precedência sobre "já revertida"', () => {
    const refund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('99.00'),
    });
    expect(
      evaluate({
        transaction: refund,
        wallet: makeWallet('100.00'),
        reference: processedRef(Bet, '10.00'),
        referenceAlreadyReversed: true,
      }),
    ).toEqual(reject(FailureCode.AmountMismatch));
  });

  test('"já revertida" tem precedência sobre saldo insuficiente na reversão', () => {
    const rollback = makeTx({ kind: Rollback, referenceExternalTransactionId: REF });
    expect(
      evaluate({
        transaction: rollback,
        wallet: makeWallet('0.00'),
        reference: processedRef(Win),
        referenceAlreadyReversed: true,
      }),
    ).toEqual(reject(FailureCode.ReferenceAlreadyReversed));
  });

  test('evaluate não altera a transação nem a wallet', () => {
    const tx = makeTx({ kind: Bet });
    const wallet = makeWallet('100.00');
    evaluate({ transaction: tx, wallet, referenceAlreadyReversed: false });
    expect(tx.status).toBe(S.Pending);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
  });
});

/**
 * Harness que imita o que a camada de aplicação fará: resolve a referência pelo id do provedor,
 * calcula "já revertida" e chama o processamento, sob uma wallet única (o lock).
 */
class Harness {
  readonly store = new Map<string, WagerTransaction>();
  readonly entries: WalletLedgerEntry[] = [];
  private entrySeq = 0;

  /** Saldo de abertura: ponto de partida para reconstruir o saldo só pelo ledger. */
  readonly openingBalance: Money;

  constructor(readonly wallet: Wallet) {
    this.openingBalance = wallet.balance;
  }

  submit(tx: WagerTransaction, now: Date = T0) {
    this.store.set(tx.externalTransactionId, tx);
    return this.evaluateAndProcess(tx, now);
  }

  reprocess(tx: WagerTransaction, now: Date) {
    return this.evaluateAndProcess(tx, now);
  }

  private evaluateAndProcess(tx: WagerTransaction, now: Date) {
    const reference = tx.referenceExternalTransactionId
      ? this.store.get(tx.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined &&
      [...this.store.values()].some(
        (other) =>
          other.status === S.Processed &&
          other.referenceTransactionId === reference.id &&
          other.kind === tx.kind,
      );
    const outcome = processTransaction({
      transaction: tx,
      wallet: this.wallet,
      reference,
      referenceAlreadyReversed,
      now,
      newEntryId: () => `entry-${++this.entrySeq}`,
      pendingReferencePolicy: policy,
      random: noRandom,
    });
    if (outcome.type === 'PROCESSED' && outcome.entry) this.entries.push(outcome.entry);
    return outcome;
  }

  /** Saldo reconstruído só pelo ledger, a partir do saldo de abertura. */
  rebuiltBalance(): Money {
    return this.entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      this.openingBalance,
    );
  }
}

describe('processTransaction: aplicação do resultado', () => {
  test('BET: debita, gera um lançamento DEBIT e guarda o saldo observado na transação', () => {
    const h = new Harness(makeWallet('100.00'));
    const bet = makeTx({ kind: Bet, money: brl('25.00') });
    const outcome = h.submit(bet);

    expect(outcome.type).toBe('PROCESSED');
    expect(h.wallet.balance.amount).toBe('75.00');
    expect(h.wallet.version).toBe(2);
    expect(bet.status).toBe(S.Processed);
    expect(bet.balanceSnapshot?.amount).toBe('75.00');
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]?.direction).toBe(LedgerDirection.Debit);
    expect(h.entries[0]?.transactionId).toBe(bet.id);
  });

  test('LOSS: PROCESSED sem lançamento, sem mexer na wallet, e o snapshot é o saldo atual', () => {
    const h = new Harness(makeWallet('100.00'));
    const loss = makeTx({ kind: Loss });
    const outcome = h.submit(loss);

    expect(outcome).toEqual({ type: 'PROCESSED', entry: null });
    expect(loss.status).toBe(S.Processed);
    expect(loss.balanceSnapshot?.amount).toBe('100.00');
    expect(h.wallet.version).toBe(1);
    expect(h.entries).toHaveLength(0);
  });

  test('REJECTED não altera saldo nem gera ledger, e guarda o saldo observado', () => {
    const h = new Harness(makeWallet('10.00'));
    const bet = makeTx({ kind: Bet, money: brl('50.00') });
    const outcome = h.submit(bet);

    expect(outcome).toEqual({ type: 'REJECTED', failureCode: FailureCode.InsufficientFunds });
    expect(bet.status).toBe(S.Rejected);
    expect(bet.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(bet.balanceSnapshot?.amount).toBe('10.00');
    expect(h.wallet.balance.amount).toBe('10.00');
    expect(h.wallet.version).toBe(1);
    expect(h.entries).toHaveLength(0);
  });

  test('cenário obrigatório: 100.00 e duas apostas de 80.00 → uma PROCESSED, outra REJECTED, saldo 20.00, um débito', () => {
    const h = new Harness(makeWallet('100.00'));
    const first = makeTx({ kind: Bet, money: brl('80.00') });
    const second = makeTx({ kind: Bet, money: brl('80.00') });
    h.submit(first);
    h.submit(second);

    expect([first.status, second.status]).toEqual([S.Processed, S.Rejected]);
    expect(second.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(h.wallet.balance.amount).toBe('20.00');
    expect(h.entries.filter((e) => e.direction === LedgerDirection.Debit)).toHaveLength(1);
    expect(h.rebuiltBalance().equals(h.wallet.balance)).toBe(true);
  });

  test('ROLLBACK de WIN sem saldo: REJECTED com REVERSAL_WOULD_OVERDRAW, sem ledger, e o crédito do WIN permanece', () => {
    const h = new Harness(makeWallet('0.00'));
    const win = makeTx({ kind: Win, externalTransactionId: 'win-1', money: brl('50.00') });
    h.submit(win);
    const spend = makeTx({ kind: Bet, money: brl('50.00') });
    h.submit(spend); // gasta tudo: saldo 0.00
    const rollback = makeTx({
      kind: Rollback,
      referenceExternalTransactionId: 'win-1',
      money: brl('50.00'),
    });
    const outcome = h.submit(rollback);

    expect(outcome).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReversalWouldOverdraw });
    expect(rollback.balanceSnapshot?.amount).toBe('0.00');
    expect(h.entries).toHaveLength(2); // WIN e BET; nada para o rollback rejeitado
    expect(h.rebuiltBalance().equals(h.wallet.balance)).toBe(true);
  });

  test('reversão processada guarda o id interno da referência', () => {
    const h = new Harness(makeWallet('100.00'));
    const bet = makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') });
    h.submit(bet);
    const refund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    h.submit(refund);

    expect(refund.status).toBe(S.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(h.wallet.balance.amount).toBe('100.00');
  });

  test('uma referência admite um REFUND e um ROLLBACK, mas não dois do mesmo tipo', () => {
    const h = new Harness(makeWallet('100.00'));
    h.submit(makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') }));
    const refund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    const secondRefund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    const rollback = makeTx({
      kind: Rollback,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    const secondRollback = makeTx({
      kind: Rollback,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    h.submit(refund);
    h.submit(secondRefund);
    h.submit(rollback);
    h.submit(secondRollback);

    expect(refund.status).toBe(S.Processed);
    expect(secondRefund.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(rollback.status).toBe(S.Processed);
    expect(secondRollback.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    expect(h.wallet.balance.amount).toBe('130.00'); // um processamento para cada tipo de reversão
  });

  test('um REFUND já processado pode ser revertido por ROLLBACK', () => {
    const h = new Harness(makeWallet('100.00'));
    h.submit(makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') })); // 70
    h.submit(
      makeTx({
        kind: Refund,
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: REF,
        money: brl('30.00'),
      }),
    ); // 100
    const rollback = makeTx({
      kind: Rollback,
      referenceExternalTransactionId: 'refund-1',
      money: brl('30.00'),
    });
    h.submit(rollback);

    expect(rollback.status).toBe(S.Processed);
    expect(h.wallet.balance.amount).toBe('70.00');
  });

  test('uma reversão rejeitada não consome a reversão da referência', () => {
    const h = new Harness(makeWallet('100.00'));
    h.submit(makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') }));
    const wrongAmount = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('29.00'),
    });
    h.submit(wrongAmount);
    expect(wrongAmount.failureCode).toBe(FailureCode.AmountMismatch);

    const correct = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    h.submit(correct);
    expect(correct.status).toBe(S.Processed);
  });

  test('transação terminal ou de outra wallet é erro de programação', () => {
    const h = new Harness(makeWallet('100.00'));
    const done = makeProcessed({ kind: Bet });
    expect(() => h.reprocess(done, T0)).toThrow(InvalidTransactionStateError);
    const elsewhere = makeTx({ kind: Bet, walletId: 'other-wallet' });
    expect(() => h.reprocess(elsewhere, T0)).toThrow(InvalidTransactionStateError);
  });
});

describe('processTransaction: PENDING_REFERENCE, backoff e TTL', () => {
  const T = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  test('REFUND antes da BET: entra em PENDING_REFERENCE uma vez, sem efeito no saldo', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('10.00'),
    });
    const outcome = h.submit(refund, T0);

    expect(outcome).toEqual({ type: 'PENDING_REFERENCE', enteredNow: true });
    expect(refund.status).toBe(S.PendingReference);
    expect(refund.referenceAttempts).toBe(0);
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(T(5).getTime()); // base 5s, sem jitter
    expect(h.wallet.version).toBe(1);
    expect(h.entries).toHaveLength(0);
  });

  test('reavaliações sem referência crescem em backoff exponencial e não reemitem a entrada', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({ kind: Refund, referenceExternalTransactionId: REF });
    h.submit(refund, T0);

    const second = h.reprocess(refund, T(5));
    expect(second).toEqual({ type: 'PENDING_REFERENCE', enteredNow: false });
    expect(refund.referenceAttempts).toBe(1);
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(T(5 + 10).getTime());

    h.reprocess(refund, T(15));
    expect(refund.referenceAttempts).toBe(2);
    expect(refund.nextReferenceAttemptAt?.getTime()).toBe(T(15 + 20).getTime());
  });

  test('quando a referência chega, a reavaliação processa e guarda o id interno', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    h.submit(refund, T0);
    expect(h.wallet.balance.amount).toBe('100.00');

    const bet = makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') });
    h.submit(bet, T(2)); // 70.00
    const outcome = h.reprocess(refund, T(5));

    expect(outcome.type).toBe('PROCESSED');
    expect(refund.status).toBe(S.Processed);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(h.wallet.balance.amount).toBe('100.00');
    expect(refund.nextReferenceAttemptAt).toBeUndefined();
    expect(h.rebuiltBalance().equals(h.wallet.balance)).toBe(true);
  });

  test('cadeia pendente: ROLLBACK de um REFUND que ainda espera também espera', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({
      kind: Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    const rollback = makeTx({
      kind: Rollback,
      referenceExternalTransactionId: 'refund-1',
      money: brl('30.00'),
    });
    h.submit(refund, T0);
    const outcome = h.submit(rollback, T(1));

    expect(outcome).toEqual({ type: 'PENDING_REFERENCE', enteredNow: true });
    expect(rollback.status).toBe(S.PendingReference);

    h.submit(makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') }), T(2)); // 70
    h.reprocess(refund, T(5)); // 100
    h.reprocess(rollback, T(6)); // 70
    expect([refund.status, rollback.status]).toEqual([S.Processed, S.Processed]);
    expect(h.wallet.balance.amount).toBe('70.00');
    expect(h.rebuiltBalance().equals(h.wallet.balance)).toBe(true);
  });

  test('TTL esgotado sem a referência → REJECTED com REFERENCE_NOT_FOUND e saldo observado', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({ kind: Refund, referenceExternalTransactionId: REF });
    h.submit(refund, T0);
    const outcome = h.reprocess(refund, T(3600));

    expect(outcome).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotFound });
    expect(refund.status).toBe(S.Rejected);
    expect(refund.balanceSnapshot?.amount).toBe('100.00');
    expect(h.entries).toHaveLength(0);
  });

  test('a fronteira do TTL: 1 segundo antes ainda espera, exatamente no TTL rejeita', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({ kind: Refund, referenceExternalTransactionId: REF });
    h.submit(refund, T0);
    expect(h.reprocess(refund, T(3599)).type).toBe('PENDING_REFERENCE');
    expect(h.reprocess(refund, T(3600)).type).toBe('REJECTED');
  });

  test('TTL esgotado com a referência existente mas ainda pendente → REFERENCE_NOT_PROCESSED', () => {
    const h = new Harness(makeWallet('100.00'));
    const refund = makeTx({
      kind: Refund,
      externalTransactionId: 'refund-1',
      referenceExternalTransactionId: REF,
    });
    const rollback = makeTx({
      kind: Rollback,
      referenceExternalTransactionId: 'refund-1',
      money: brl('10.00'),
    });
    h.submit(refund, T0);
    h.submit(rollback, T0);
    const outcome = h.reprocess(rollback, T(3600));

    expect(outcome).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotProcessed });
  });

  test('uma referência que chega REJECTED encerra a espera imediatamente (sem aguardar o TTL)', () => {
    const h = new Harness(makeWallet('5.00'));
    const refund = makeTx({
      kind: Refund,
      referenceExternalTransactionId: REF,
      money: brl('30.00'),
    });
    h.submit(refund, T0);
    const bet = makeTx({ kind: Bet, externalTransactionId: REF, money: brl('30.00') });
    h.submit(bet, T(1)); // saldo 5.00 < 30.00 → REJECTED

    const outcome = h.reprocess(refund, T(5));
    expect(outcome).toEqual({ type: 'REJECTED', failureCode: FailureCode.ReferenceNotProcessed });
  });
});

describe('processTransaction: invariante saldo == ledger numa sequência mista', () => {
  test('BET, WIN, REFUND, ROLLBACK e LOSS: o saldo bate com o ledger a cada passo', () => {
    const h = new Harness(makeWallet('100.00'));
    const steps: Array<[string, WagerTransaction, string]> = [
      ['BET 30', makeTx({ kind: Bet, externalTransactionId: 'b1', money: brl('30.00') }), '70.00'],
      [
        'WIN 50 (ref b1)',
        makeTx({
          kind: Win,
          externalTransactionId: 'w1',
          referenceExternalTransactionId: 'b1',
          money: brl('50.00'),
        }),
        '120.00',
      ],
      ['BET 20', makeTx({ kind: Bet, externalTransactionId: 'b2', money: brl('20.00') }), '100.00'],
      [
        'REFUND b2',
        makeTx({
          kind: Refund,
          externalTransactionId: 'r1',
          referenceExternalTransactionId: 'b2',
          money: brl('20.00'),
        }),
        '120.00',
      ],
      [
        'ROLLBACK w1',
        makeTx({
          kind: Rollback,
          externalTransactionId: 'rb1',
          referenceExternalTransactionId: 'w1',
          money: brl('50.00'),
        }),
        '70.00',
      ],
      [
        'LOSS',
        makeTx({ kind: Loss, externalTransactionId: 'l1', referenceExternalTransactionId: 'b1' }),
        '70.00',
      ],
      [
        'ROLLBACK r1 (de um REFUND)',
        makeTx({
          kind: Rollback,
          externalTransactionId: 'rb2',
          referenceExternalTransactionId: 'r1',
          money: brl('20.00'),
        }),
        '50.00',
      ],
      [
        'BET acima do saldo (rejeitada)',
        makeTx({ kind: Bet, externalTransactionId: 'b3', money: brl('500.00') }),
        '50.00',
      ],
    ];

    for (const [label, tx, expectedBalance] of steps) {
      h.submit(tx);
      expect(h.wallet.balance.amount, label).toBe(expectedBalance);
      expect(h.rebuiltBalance().equals(h.wallet.balance), `ledger em "${label}"`).toBe(true);
    }

    // 6 movimentações (b1, w1, b2, r1, rb1, rb2); LOSS e a rejeitada não geram lançamento.
    expect(h.entries).toHaveLength(6);
    expect(h.wallet.version).toBe(1 + 6);
    expect(h.entries.every((entry) => entry.isBalanced())).toBe(true);
    for (let i = 1; i < h.entries.length; i++) {
      expect(
        h.entries[i]?.balanceBefore.equals((h.entries[i - 1] as WalletLedgerEntry).balanceAfter),
      ).toBe(true);
    }
    // No máximo um lançamento por transação.
    expect(new Set(h.entries.map((entry) => entry.transactionId)).size).toBe(h.entries.length);
  });
});
