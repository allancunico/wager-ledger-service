import { Money } from '../../../src/domain/shared/money';
import { hashPayload } from '../../../src/domain/wagering/payload-hash';
import { PendingReferencePolicy } from '../../../src/domain/wagering/pending-reference-policy';
import {
  type FailureCode,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction';
import { Wallet } from '../../../src/domain/wallet/wallet';

export const T0 = new Date('2026-01-01T00:00:00.000Z');
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
export const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

export const WALLET_ID = 'wallet-1';
export const PLAYER_ID = 'player-1';
export const PROVIDER_ID = 'provider-a';
export const ROUND_ID = 'round-1';

export function makeWallet(balance = '100.00', overrides: { playerId?: string } = {}): Wallet {
  return Wallet.rehydrate({
    id: WALLET_ID,
    playerId: overrides.playerId ?? PLAYER_ID,
    currency: 'BRL',
    balance: brl(balance),
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
}

export interface TxOverrides {
  id?: string;
  providerId?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  walletId?: string;
  playerId?: string;
  roundId?: string;
  gameId?: string;
  kind?: WagerTransactionKind;
  money?: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
}

let sequence = 0;

/** Transação nova (PENDING), com defaults coerentes com `makeWallet`. */
export function makeTx(overrides: TxOverrides = {}): WagerTransaction {
  sequence += 1;
  const kind = overrides.kind ?? WagerTransactionKind.Bet;
  const external = overrides.externalTransactionId ?? `ext-${sequence}`;
  const money = overrides.money ?? brl('10.00');
  const base = {
    providerId: overrides.providerId ?? PROVIDER_ID,
    externalTransactionId: external,
    playerId: overrides.playerId ?? PLAYER_ID,
    walletId: overrides.walletId ?? WALLET_ID,
    roundId: overrides.roundId ?? ROUND_ID,
    gameId: overrides.gameId ?? 'game-1',
    kind,
    money,
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
  };
  return WagerTransaction.create({
    id: overrides.id ?? `tx-${sequence}`,
    ...base,
    idempotencyKey: overrides.idempotencyKey ?? `${base.providerId}:${external}`,
    payloadHash: hashPayload(base),
    createdAt: overrides.createdAt ?? T0,
  });
}

/** Transação já PROCESSED (referência válida para REFUND/ROLLBACK/WIN). */
export function makeProcessed(overrides: TxOverrides = {}): WagerTransaction {
  const tx = makeTx(overrides);
  // Reversões só são processadas com o id interno da referência: o domínio recusa sem ele.
  const snapshot = Money.from({ amount: '100.00', currency: tx.money.currency });
  tx.markProcessed(tx.requiresReference() ? `internal-ref-of-${tx.id}` : undefined, T0, snapshot);
  return tx;
}

/** Transação em um estado arbitrário, via `rehydrate`. */
export function makeInStatus(
  status: WagerTransactionStatus,
  overrides: TxOverrides & { failureCode?: FailureCode } = {},
): WagerTransaction {
  const source = makeTx(overrides);
  return WagerTransaction.rehydrate({
    id: source.id,
    providerId: source.providerId,
    externalTransactionId: source.externalTransactionId,
    idempotencyKey: source.idempotencyKey,
    payloadHash: source.payloadHash,
    walletId: source.walletId,
    playerId: source.playerId,
    roundId: source.roundId,
    gameId: source.gameId,
    kind: source.kind,
    money: source.money,
    referenceExternalTransactionId: source.referenceExternalTransactionId,
    createdAt: source.createdAt,
    status,
    failureCode: overrides.failureCode,
    referenceAttempts: 0,
  });
}

/** TTL de 1h e backoff 5s base / 300s teto, sem jitter: determinístico. */
export const policy = new PendingReferencePolicy({
  ttlSeconds: 3600,
  backoff: { baseSeconds: 5, maxSeconds: 300, jitterRatio: 0 },
});

export const noRandom = () => 0.5;
