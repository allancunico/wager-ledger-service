import { z } from 'zod';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';

/** Envelope de entrada conforme o contrato do desafio; o ID do broker continua separado. */
export const transactionMessageSchema = z.strictObject({
  messageId: z.string().min(1).max(255),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.iso.datetime(),
  data: z.strictObject({
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
  }),
});

export type TransactionMessage = z.infer<typeof transactionMessageSchema>;
