import { InvalidInputError, LedgerImbalanceError } from '../shared/errors';
import type { Money } from '../shared/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export function oppositeDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
}

/**
 * Lançamento imutável do ledger.
 *
 * A imutabilidade é estrutural: todos os campos são `readonly`, não há método de transição e a
 * instância é congelada. O banco reforça isso com trigger que bloqueia UPDATE e DELETE.
 *
 * `create` valida a aritmética (`balanceBefore ± money === balanceAfter`). `rehydrate` só
 * reconstrói estado já persistido, sem revalidar.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    for (const [field, value] of [
      ['id', props.id],
      ['walletId', props.walletId],
      ['transactionId', props.transactionId],
    ] as const) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidInputError(`Lançamento exige ${field} não vazio`);
      }
    }
    if (!props.money.isPositive()) {
      throw new LedgerImbalanceError('O valor de um lançamento deve ser positivo');
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new LedgerImbalanceError('Um lançamento não pode envolver saldo negativo');
    }

    const entry = WalletLedgerEntry.build(props);
    if (!entry.isBalanced()) {
      throw new LedgerImbalanceError(
        `Lançamento desbalanceado: ${props.balanceBefore} ${props.direction} ${props.money} ` +
          `não resulta em ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  /** Reconstrução a partir da persistência. Não revalida. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return WalletLedgerEntry.build(state);
  }

  /** `balanceBefore ± money === balanceAfter`, conforme a direção. Moedas diferentes não fecham. */
  isBalanced(): boolean {
    const sameCurrency =
      this.money.currency === this.balanceBefore.currency &&
      this.money.currency === this.balanceAfter.currency;
    if (!sameCurrency) return false;
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  private static build(props: CreateLedgerEntryProps): WalletLedgerEntry {
    return new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      new Date(props.createdAt.getTime()),
    );
  }
}
