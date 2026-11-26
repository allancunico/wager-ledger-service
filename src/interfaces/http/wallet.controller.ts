import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { newId } from '../../application/shared/ids';
import { WalletService } from '../../application/wallets/wallet-service';
import { Money } from '../../domain/shared/money';
import { HttpInputError } from './wager-transaction.controller';

export const WALLET_SERVICE = Symbol('WALLET_SERVICE');

const createWalletSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: z.strictObject({ amount: z.string(), currency: z.string() }),
});

const ledgerQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(256).optional(),
});
const walletIdSchema = z.uuid();

@Controller('wallets')
export class WalletController {
  constructor(@Inject(WALLET_SERVICE) private readonly wallets: WalletService) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationHeader: string | undefined,
    @Res() response: Response,
  ) {
    const parsed = createWalletSchema.safeParse(body);
    if (!parsed.success) throw new HttpInputError(parsed.error.issues);
    const correlationId = validCorrelationId(correlationHeader);
    response.setHeader('x-correlation-id', correlationId);
    const wallet = await this.wallets.create({
      playerId: parsed.data.playerId,
      initialBalance: moneyFromObject(parsed.data.initialBalance),
      correlationId,
    });
    return response.status(201).json(walletView(wallet));
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query() query: unknown,
    @Res() response: Response,
  ) {
    const parsedId = walletIdSchema.safeParse(walletId);
    if (!parsedId.success) throw new HttpInputError(parsedId.error.issues);
    const parsed = ledgerQuerySchema.safeParse(query);
    if (!parsed.success) throw new HttpInputError(parsed.error.issues);
    return response
      .status(200)
      .json(await this.wallets.getLedger(walletId, parsed.data.limit, parsed.data.cursor));
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string, @Res() response: Response) {
    const parsedId = walletIdSchema.safeParse(walletId);
    if (!parsedId.success) throw new HttpInputError(parsedId.error.issues);
    return response.status(200).json(await this.wallets.reconcile(walletId));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string, @Res() response: Response) {
    const parsedId = walletIdSchema.safeParse(walletId);
    if (!parsedId.success) throw new HttpInputError(parsedId.error.issues);
    return response.status(200).json(walletView(await this.wallets.get(walletId)));
  }
}

export function walletView(wallet: import('../../domain/wallet/wallet').Wallet) {
  return {
    id: wallet.id,
    /** Backward-compatible alias; the challenge contract names this field `id`. */
    walletId: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

function moneyFromObject(value: { amount: string; currency: string }): Money {
  return Money.from(value);
}

function validCorrelationId(value?: string): string {
  return value && value.length <= 128 ? value : newId();
}
