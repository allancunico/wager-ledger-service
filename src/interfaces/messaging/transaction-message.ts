import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';

/** Contrato da fila de entrada: corpo de negócio HTTP mais chave de idempotência no JSON. */
export const transactionMessageSchema = z.strictObject({
  providerId: z.string().min(1).max(255),
  externalTransactionId: z.string().min(1).max(255),
  idempotencyKey: z.string().min(1).max(255),
  playerId: z.uuid(),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(255),
  gameId: z.string().min(1).max(255),
  kind: z.enum([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ]),
  money: z.strictObject({ amount: z.string(), currency: z.string() }),
  referenceExternalTransactionId: z.string().min(1).max(255).optional(),
  correlationId: z.string().min(1).max(128).optional(),
});

export type TransactionMessage = z.infer<typeof transactionMessageSchema>;
