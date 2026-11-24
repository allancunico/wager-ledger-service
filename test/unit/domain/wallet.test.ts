import { describe, expect, test } from 'bun:test';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidInputError,
  InvalidMoneyError,
  LedgerImbalanceError,
} from '../../../src/domain/shared/errors';
import { Money } from '../../../src/domain/shared/money';
import { Wallet } from '../../../src/domain/wallet/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:00:05.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

function openWallet(initial = '100.00') {
  const { wallet, openingEntry } = Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    at: T0,
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
  });
  return { wallet, openingEntry };
}

const move = (n: number, amount: string, at = T1) => ({
  entryId: `entry-${n}`,
  transactionId: `tx-${n}`,
  money: brl(amount),
  at,
});

describe('Wallet.open', () => {
  test('nasce com version 1, saldo inicial e moeda do saldo', () => {
    const { wallet } = openWallet('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('1000.00');
    expect(wallet.currency).toBe('BRL');
    expect(wallet.createdAt.getTime()).toBe(T0.getTime());
    expect(wallet.updatedAt.getTime()).toBe(T0.getTime());
  });

  test('saldo inicial positivo gera o lançamento CREDIT de abertura, de 0.00 até o saldo', () => {
    const { openingEntry } = openWallet('1000.00');
    expect(openingEntry).not.toBeNull();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.amount).toBe('0.00');
    expect(openingEntry?.balanceAfter.amount).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('tx-opening');
    expect(openingEntry?.isBalanced()).toBe(true);
  });

  test('saldo inicial zero não gera lançamento e não exige ids de abertura', () => {
    const { wallet, openingEntry } = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: Money.zero('BRL'),
      at: T0,
    });
    expect(openingEntry).toBeNull();
    expect(wallet.balance.isZero()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('saldo inicial positivo sem ids de abertura é recusado (saldo sem ledger)', () => {
    expect(() =>
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('1.00'), at: T0 }),
    ).toThrow(InvalidInputError);
  });

  test('recusa saldo inicial negativo, id e playerId vazios', () => {
    const negative = brl('1.00').negate();
    expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: negative, at: T0 })).toThrow(
      InvalidMoneyError,
    );
    expect(() =>
      Wallet.open({ id: '', playerId: 'p', initialBalance: Money.zero('BRL'), at: T0 }),
    ).toThrow(InvalidInputError);
    expect(() =>
      Wallet.open({ id: 'w', playerId: '', initialBalance: Money.zero('BRL'), at: T0 }),
    ).toThrow(InvalidInputError);
  });
});

describe('Wallet.debit e credit', () => {
  test('debit reduz o saldo, sobe a version e devolve o lançamento DEBIT correspondente', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.debit(move(1, '25.00'));

    expect(wallet.balance.amount).toBe('75.00');
    expect(wallet.version).toBe(2);
    expect(wallet.updatedAt.getTime()).toBe(T1.getTime());
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.amount).toBe('100.00');
    expect(entry.balanceAfter.amount).toBe('75.00');
    expect(entry.money.amount).toBe('25.00');
    expect(entry.walletId).toBe('wallet-1');
    expect(entry.transactionId).toBe('tx-1');
  });

  test('credit aumenta o saldo e devolve o lançamento CREDIT', () => {
    const { wallet } = openWallet('100.00');
    const entry = wallet.credit(move(1, '0.01'));
    expect(wallet.balance.amount).toBe('100.01');
    expect(wallet.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.amount).toBe('100.01');
  });

  test('a version sobe uma vez por movimentação, e o saldo bate com o ledger acumulado', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries = [openingEntry as WalletLedgerEntry];
    entries.push(wallet.debit(move(1, '30.00')));
    entries.push(wallet.credit(move(2, '12.34')));
    entries.push(wallet.debit(move(3, '0.34')));

    expect(wallet.version).toBe(4);
    const replayed = entries.reduce(
      (balance, entry) =>
        entry.direction === LedgerDirection.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      Money.zero('BRL'),
    );
    expect(replayed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.amount).toBe('82.00');
    // Cadeia contínua: o "antes" de cada lançamento é o "depois" do anterior.
    for (let i = 1; i < entries.length; i++) {
      expect(
        (entries[i] as WalletLedgerEntry).balanceBefore.equals(
          (entries[i - 1] as WalletLedgerEntry).balanceAfter,
        ),
      ).toBe(true);
    }
  });

  test('debitar exatamente o saldo zera a wallet (permitido)', () => {
    const { wallet } = openWallet('80.00');
    wallet.debit(move(1, '80.00'));
    expect(wallet.balance.amount).toBe('0.00');
  });

  test('debitar além do saldo lança InsufficientFundsError e não altera nada', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit(move(1, '100.01'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt.getTime()).toBe(T0.getTime());
  });

  test('o cenário obrigatório, em domínio: 100.00 e duas apostas de 80.00 em sequência', () => {
    const { wallet } = openWallet('100.00');
    wallet.debit(move(1, '80.00'));
    expect(() => wallet.debit(move(2, '80.00'))).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('moeda diferente da wallet é recusada em debit, credit e canDebit', () => {
    const { wallet } = openWallet('100.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });
    expect(() => wallet.debit({ ...move(1, '1.00'), money: usd })).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit({ ...move(1, '1.00'), money: usd })).toThrow(CurrencyMismatchError);
    expect(() => wallet.canDebit(usd)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('valor zero ou negativo é recusado, e a version não sobe', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.debit({ ...move(1, '1.00'), money: Money.zero('BRL') })).toThrow(
      InvalidMoneyError,
    );
    expect(() => wallet.credit({ ...move(1, '1.00'), money: brl('1.00').negate() })).toThrow(
      InvalidMoneyError,
    );
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe('100.00');
  });

  test('um lançamento inválido não deixa a wallet pela metade (saldo e version intactos)', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.credit({ ...move(1, '1.00'), transactionId: '' })).toThrow(
      InvalidInputError,
    );
    expect(wallet.balance.amount).toBe('100.00');
    expect(wallet.version).toBe(1);
  });

  test('canDebit não altera o estado', () => {
    const { wallet } = openWallet('50.00');
    expect(wallet.canDebit(brl('50.00'))).toBe(true);
    expect(wallet.canDebit(brl('50.01'))).toBe(false);
    expect(wallet.version).toBe(1);
  });
});

describe('Wallet.rehydrate', () => {
  test('reconstrói o estado exatamente, sem revalidar e sem gerar lançamento', () => {
    const wallet = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: brl('975.00'),
      version: 7,
      createdAt: T0,
      updatedAt: T1,
    });
    expect(wallet.balance.amount).toBe('975.00');
    expect(wallet.version).toBe(7);
    expect(wallet.updatedAt.getTime()).toBe(T1.getTime());
  });

  test('o Date devolvido é uma cópia (o estado interno não vaza)', () => {
    const { wallet } = openWallet();
    wallet.updatedAt.setUTCFullYear(1999);
    expect(wallet.updatedAt.getTime()).toBe(T0.getTime());
  });
});

describe('WalletLedgerEntry', () => {
  const base = {
    id: 'e1',
    walletId: 'w1',
    transactionId: 't1',
    createdAt: T0,
  };

  test('create aceita lançamentos balanceados nas duas direções', () => {
    const credit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('15.00'),
    });
    const debit = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('10.00'),
      balanceBefore: brl('15.00'),
      balanceAfter: brl('5.00'),
    });
    expect(credit.isBalanced()).toBe(true);
    expect(debit.isBalanced()).toBe(true);
  });

  test.each([
    ['crédito que não soma', LedgerDirection.Credit, '10.00', '5.00', '14.99'],
    ['débito que não subtrai', LedgerDirection.Debit, '10.00', '15.00', '5.01'],
    [
      'direção trocada (crédito registrado como débito)',
      LedgerDirection.Debit,
      '10.00',
      '5.00',
      '15.00',
    ],
  ])('create recusa %s', (_label, direction, money, before, after) => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction,
        money: brl(money),
        balanceBefore: brl(before),
        balanceAfter: brl(after),
      }),
    ).toThrow(LedgerImbalanceError);
  });

  test('create recusa valor zero, saldo negativo e moedas misturadas', () => {
    const common = { ...base, direction: LedgerDirection.Credit };
    expect(() =>
      WalletLedgerEntry.create({
        ...common,
        money: Money.zero('BRL'),
        balanceBefore: brl('1.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(LedgerImbalanceError);
    expect(() =>
      WalletLedgerEntry.create({
        ...common,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('5.00').subtract(brl('10.00')), // -5.00: saldo negativo
      }),
    ).toThrow(LedgerImbalanceError);
    const usd = (amount: string) => Money.from({ amount, currency: 'USD' });
    expect(() =>
      WalletLedgerEntry.create({
        ...common,
        money: brl('1.00'),
        balanceBefore: usd('1.00'),
        balanceAfter: usd('2.00'),
      }),
    ).toThrow(LedgerImbalanceError);
  });

  test('create recusa ids vazios', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        id: '',
        direction: LedgerDirection.Credit,
        money: brl('1.00'),
        balanceBefore: brl('0.00'),
        balanceAfter: brl('1.00'),
      }),
    ).toThrow(InvalidInputError);
  });

  test('é imutável: instância congelada e sem aliasing de Date', () => {
    const when = new Date(T0.getTime());
    const entry = WalletLedgerEntry.create({
      ...base,
      createdAt: when,
      direction: LedgerDirection.Credit,
      money: brl('1.00'),
      balanceBefore: brl('0.00'),
      balanceAfter: brl('1.00'),
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { direction: string }).direction = 'DEBIT';
    }).toThrow();
    when.setUTCFullYear(1999);
    expect(entry.createdAt.getTime()).toBe(T0.getTime());
  });

  test('rehydrate NÃO revalida (reconstrói estado já persistido), mas isBalanced continua detectando', () => {
    const corrupted = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('10.00'),
      balanceBefore: brl('5.00'),
      balanceAfter: brl('99.00'),
    });
    expect(corrupted.isBalanced()).toBe(false);
  });
});
