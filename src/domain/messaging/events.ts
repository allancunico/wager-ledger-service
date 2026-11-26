import { InvalidTransactionStateError } from '../shared/errors';
import type { MoneyProps } from '../shared/money';
import {
  type FailureCode,
  type WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from '../wagering/wager-transaction';
import type { Wallet } from '../wallet/wallet';
import type { LedgerDirection, WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import { type EventContext, IntegrationEvent } from './integration-event';

/** Campos que identificam a transação, comuns aos eventos de transação. */
interface TransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

function transactionData(tx: WagerTransaction): TransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
  };
}

function assertStatus(tx: WagerTransaction, expected: WagerTransactionStatus, event: string): void {
  if (tx.status !== expected) {
    throw new InvalidTransactionStateError(
      `${event} exige transação ${expected}, estado atual: ${tx.status}`,
    );
  }
}

function toProps(ctx: EventContext, aggregateId: string) {
  return {
    eventId: ctx.eventId,
    aggregateId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    occurredAt: ctx.occurredAt,
  };
}

// ---------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends TransactionEventData {
  /** Saldo da wallet observado quando a transação foi aplicada. */
  balance: MoneyProps;
  /** Id interno da referência, nas reversões e nos WIN com referência resolvida. */
  referenceTransactionId?: string;
}

/** Qualquer transação aplicada, inclusive `LOSS` (que não move saldo). */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(tx, WagerTransactionStatus.Processed, 'WagerTransactionProcessed');
    if (!tx.balanceSnapshot) {
      throw new InvalidTransactionStateError('Transação processada sem saldo observado');
    }
    const data: WagerTransactionProcessedData = {
      ...transactionData(tx),
      balance: tx.balanceSnapshot.toJSON(),
    };
    if (tx.referenceTransactionId !== undefined) {
      data.referenceTransactionId = tx.referenceTransactionId;
    }
    return new WagerTransactionProcessed({ ...toProps(ctx, tx.id), data });
  }

  groupKey(): string {
    return this.data.walletId;
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends TransactionEventData {
  failureCode: FailureCode;
  /** Saldo observado na rejeição. */
  balance?: MoneyProps;
}

/** Transação rejeitada por regra de negócio (inclui o fim do TTL de `PENDING_REFERENCE`). */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(tx, WagerTransactionStatus.Rejected, 'WagerTransactionRejected');
    if (!tx.failureCode) {
      throw new InvalidTransactionStateError('Transação rejeitada sem failureCode');
    }
    const data: WagerTransactionRejectedData = {
      ...transactionData(tx),
      failureCode: tx.failureCode,
    };
    if (tx.balanceSnapshot) {
      data.balance = tx.balanceSnapshot.toJSON();
    }
    return new WagerTransactionRejected({ ...toProps(ctx, tx.id), data });
  }

  groupKey(): string {
    return this.data.walletId;
  }
}

// ---------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends TransactionEventData {
  referenceExternalTransactionId: string;
}

/** Referência ausente. Sai uma vez, na entrada em `PENDING_REFERENCE`, e não a cada reavaliação. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(tx, WagerTransactionStatus.PendingReference, 'WagerTransactionPendingReference');
    if (tx.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        'PENDING_REFERENCE sem referenceExternalTransactionId',
      );
    }
    return new WagerTransactionPendingReference({
      ...toProps(ctx, tx.id),
      data: {
        ...transactionData(tx),
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
      },
    });
  }

  groupKey(): string {
    return this.data.walletId;
  }
}

// ---------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** SOMENTE quando o saldo muda: nasce de um lançamento do ledger, que `LOSS` e rejeições não têm. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidTransactionStateError(
        `Lançamento da wallet ${entry.walletId} não pertence à wallet ${wallet.id}`,
      );
    }
    if (!entry.balanceAfter.equals(wallet.balance)) {
      throw new InvalidTransactionStateError(
        'O evento deve ser criado logo após a movimentação: o saldo da wallet não bate com o lançamento',
      );
    }
    return new WalletBalanceChanged({
      ...toProps(ctx, wallet.id),
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }

  groupKey(): string {
    return this.data.walletId;
  }
}
