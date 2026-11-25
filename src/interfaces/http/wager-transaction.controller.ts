import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { newId } from '../../application/shared/ids';
import { WagerTransactionService } from '../../application/wagering/wager-transaction-service';
import { Money } from '../../domain/shared/money';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction';

export const WAGER_TRANSACTION_SERVICE = Symbol('WAGER_TRANSACTION_SERVICE');

const transactionSchema = z.strictObject({
  providerId: z.string().min(1).max(255),
  externalTransactionId: z.string().min(1).max(255),
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
});
const transactionIdSchema = z.uuid();

@Controller('transactions')
export class WagerTransactionController {
  constructor(
    @Inject(WAGER_TRANSACTION_SERVICE) private readonly transactions: WagerTransactionService,
  ) {}

  @Post()
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Res() response: Response,
  ) {
    const parsed = transactionSchema.safeParse(body);
    if (!parsed.success) throw new HttpInputError(parsed.error.issues);
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new HttpInputError([
        { message: 'Header Idempotency-Key é obrigatório e deve ter até 255 caracteres' },
      ]);
    }
    const correlationId =
      correlationHeader && correlationHeader.length <= 128 ? correlationHeader : newId();
    response.setHeader('x-correlation-id', correlationId);
    const result = await this.transactions.submit({
      ...parsed.data,
      kind: parsed.data.kind as WagerTransactionKind,
      money: Money.from(parsed.data.money),
      idempotencyKey,
      correlationId,
    });
    return response.status(result.httpStatus).json(result.body);
  }

  @Get('by-external/:providerId/:externalTransactionId')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Res() response: Response,
  ) {
    const parsedProvider = z.string().min(1).max(255).safeParse(providerId);
    const parsedExternalId = z.string().min(1).max(255).safeParse(externalTransactionId);
    if (!parsedProvider.success) throw new HttpInputError(parsedProvider.error.issues);
    if (!parsedExternalId.success) throw new HttpInputError(parsedExternalId.error.issues);
    return response
      .status(200)
      .json(await this.transactions.getByExternalId(providerId, externalTransactionId));
  }

  @Get(':transactionId')
  async getById(@Param('transactionId') transactionId: string, @Res() response: Response) {
    const parsedId = transactionIdSchema.safeParse(transactionId);
    if (!parsedId.success) throw new HttpInputError(parsedId.error.issues);
    return response.status(200).json(await this.transactions.getById(transactionId));
  }
}

export class HttpInputError extends Error {
  constructor(readonly issues: readonly { message: string }[]) {
    super(issues.map((issue) => issue.message).join('; '));
  }
}
