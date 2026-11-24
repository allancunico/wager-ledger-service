import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidInputError,
  InvalidMoneyError,
} from '../shared/errors';
import { Money } from '../shared/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Identificadores do crédito de abertura (a transação `OPENING` e o lançamento dela). */
export interface OpeningIds {
  transactionId: string;
  entryId: string;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  at: Date;
  /** Obrigatório quando `initialBalance` > 0: sem ele não haveria lançamento para o saldo inicial. */
  opening?: OpeningIds;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento `CREDIT` do saldo inicial. `null` quando o saldo inicial é zero. */
  openingEntry: WalletLedgerEntry | null;
}

/** Dados de uma movimentação. O lançamento resultante carrega estes ids. */
export interface MovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Wallet (Aggregate Root).
 *
 * Invariantes protegidas aqui, e não só no banco:
 *  - saldo nunca negativo (`debit` recusa);
 *  - moeda da operação igual à da wallet;
 *  - toda alteração de saldo devolve o lançamento correspondente (saldo e ledger andam juntos);
 *  - `version` começa em 1 e só incrementa quando o saldo muda.
 *
 * A concorrência (lost update) não se resolve aqui: é responsabilidade do lock da camada de
 * persistência (`SELECT ... FOR UPDATE`). O `CHECK (balance >= 0)` do banco é a defesa em profundidade.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre uma wallet com `version = 1`. Se o saldo inicial for positivo, devolve também o
   * lançamento `CREDIT` de abertura (de saldo `0.00` até o saldo inicial), para que o saldo
   * nunca exista sem ledger.
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (!props.id) throw new InvalidInputError('Wallet exige id não vazio');
    if (!props.playerId) throw new InvalidInputError('Wallet exige playerId não vazio');
    const { initialBalance } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidMoneyError('O saldo inicial não pode ser negativo');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      initialBalance.currency,
      initialBalance,
      1,
      new Date(props.at.getTime()),
      new Date(props.at.getTime()),
    );

    if (initialBalance.isZero()) {
      return { wallet, openingEntry: null };
    }
    if (!props.opening) {
      throw new InvalidInputError(
        'Saldo inicial positivo exige os ids da transação e do lançamento de abertura',
      );
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: props.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      createdAt: props.at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrução a partir da persistência. Não revalida regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt.getTime()),
      new Date(state.updatedAt.getTime()),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt.getTime());
  }

  /** Diz se um débito de `money` caberia no saldo, sem alterar nada. */
  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debita `money`. Lança `InsufficientFundsError` se o saldo não cobrir. */
  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(
        `Saldo ${this._balance} insuficiente para debitar ${props.money}`,
      );
    }
    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovable(props.money);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    props: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });
    // Só muda o estado depois de o lançamento ter sido validado: saldo e ledger andam juntos.
    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = new Date(props.at.getTime());
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidMoneyError('Uma movimentação exige valor positivo');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(
        `Moeda ${money.currency} diferente da moeda da wallet (${this.currency})`,
      );
    }
  }
}
