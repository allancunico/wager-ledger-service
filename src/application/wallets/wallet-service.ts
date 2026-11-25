import { LockMode } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../../domain/messaging/events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/shared/money';
import { hashPayload } from '../../domain/wagering/payload-hash';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import {
  ledgerEntryToRecord,
  outboxMessageToRecord,
  wagerTransactionToRecord,
  walletFromRecord,
} from '../../infrastructure/persistence/mappers';
import {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../infrastructure/persistence/records';
import type { Clock } from '../shared/clock';
import { newId } from '../shared/ids';

export class WalletAlreadyExistsError extends Error {}
export class WalletNotFoundError extends Error {}

export interface CreateWalletInput {
  playerId: string;
  initialBalance: Money;
  correlationId?: string;
}

export class WalletService {
  constructor(
    private readonly orm: MikroORM,
    private readonly clock: Clock,
  ) {}

  async create(input: CreateWalletInput) {
    const at = this.clock.now();
    const correlationId = input.correlationId ?? newId();
    const walletId = newId();
    const opening = input.initialBalance.isPositive()
      ? { transactionId: newId(), entryId: newId() }
      : undefined;
    const opened = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      at,
      opening,
    });

    await this.orm.em.fork().transactional(async (em) => {
      const inserted = await em.execute<{ id: string }[]>(
        `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?) on conflict (player_id, currency) do nothing returning id`,
        [
          walletId,
          input.playerId,
          opened.wallet.currency,
          opened.wallet.balance.amount,
          opened.wallet.version,
          at,
          at,
        ],
      );
      if (inserted.length === 0) throw new WalletAlreadyExistsError();

      if (opened.openingEntry && opening) {
        const payloadHash = hashPayload({
          providerId: 'system',
          externalTransactionId: `opening:${walletId}`,
          playerId: input.playerId,
          walletId,
          roundId: 'opening',
          gameId: 'opening',
          kind: WagerTransactionKind.Opening,
          money: input.initialBalance,
        });
        const openingTx = WagerTransaction.opening({
          id: opening.transactionId,
          walletId,
          playerId: input.playerId,
          money: input.initialBalance,
          payloadHash,
          createdAt: at,
        });
        await em.insert(WagerTransactionRecord, wagerTransactionToRecord(openingTx));
        await em.insert(LedgerEntryRecord, ledgerEntryToRecord(opened.openingEntry));
        const processedEvent = WagerTransactionProcessed.from(openingTx, {
          eventId: newId(),
          correlationId,
          occurredAt: at,
        });
        const balanceChangedEvent = WalletBalanceChanged.from(opened.wallet, opened.openingEntry, {
          eventId: newId(),
          correlationId,
          occurredAt: at,
        });
        await em.insert(
          OutboxMessageRecord,
          outboxMessageToRecord(OutboxMessage.enqueue(processedEvent)),
        );
        await em.insert(
          OutboxMessageRecord,
          outboxMessageToRecord(OutboxMessage.enqueue(balanceChangedEvent)),
        );
      }
    });
    return opened.wallet;
  }

  async get(walletId: string): Promise<Wallet> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) throw new WalletNotFoundError();
    return walletFromRecord(record);
  }

  async getLedger(walletId: string, limit: number, cursor?: string) {
    const em = this.orm.em.fork();
    if (!(await em.findOne(WalletRecord, { id: walletId }))) throw new WalletNotFoundError();
    const beforeSeq = cursor ? decodeCursor(cursor) : undefined;
    const rows = await em.execute<
      {
        seq: string;
        id: string;
        walletId: string;
        transactionId: string;
        direction: string;
        amount: string;
        currency: string;
        balanceBefore: string;
        balanceAfter: string;
        createdAt: Date;
      }[]
    >(
      `select seq, id, wallet_id as "walletId", transaction_id as "transactionId", direction,
              amount, currency, balance_before as "balanceBefore", balance_after as "balanceAfter", created_at as "createdAt"
         from wallet_ledger_entries where wallet_id = ? ${beforeSeq ? 'and seq < ?' : ''}
        order by seq desc limit ?`,
      beforeSeq ? [walletId, beforeSeq, limit + 1] : [walletId, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map((row) => ({
      id: row.id,
      walletId: row.walletId,
      transactionId: row.transactionId,
      direction: row.direction,
      money: { amount: row.amount, currency: row.currency.trim() },
      balanceBefore: { amount: row.balanceBefore, currency: row.currency.trim() },
      balanceAfter: { amount: row.balanceAfter, currency: row.currency.trim() },
      createdAt: new Date(row.createdAt).toISOString(),
    }));
    const last = rows[Math.min(limit, rows.length) - 1];
    return {
      entries: page,
      nextCursor: hasMore && last ? encodeCursor(last.seq) : null,
    };
  }

  async reconcile(walletId: string) {
    const em = this.orm.em.fork();
    const record = await em.findOne(WalletRecord, { id: walletId });
    if (!record) throw new WalletNotFoundError();
    const [ledger] = await em.execute<
      { balance: string; chainConsistent: boolean; entryCount: string }[]
    >(
      `with ordered as (
         select direction, amount, balance_before, balance_after,
                coalesce(lag(balance_after) over (order by seq), 0::numeric) as previous_balance
           from wallet_ledger_entries where wallet_id = ?
       )
       select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::text as balance,
              coalesce(bool_and(
                balance_before = previous_balance and
                ((direction = 'CREDIT' and balance_after = balance_before + amount) or
                 (direction = 'DEBIT' and balance_after = balance_before - amount))
              ), true) as "chainConsistent",
              count(*)::text as "entryCount"
         from ordered`,
      [walletId],
    );
    const ledgerBalance = ledger?.balance ?? '0.00';
    const balance = record.balance;
    const chainConsistent = ledger?.chainConsistent ?? true;
    const balanceMatches = Money.from({ amount: balance, currency: record.currency.trim() }).equals(
      Money.from({ amount: ledgerBalance, currency: record.currency.trim() }),
    );
    return {
      walletId,
      consistent: balanceMatches && chainConsistent,
      chainConsistent,
      ledgerEntryCount: Number(ledger?.entryCount ?? '0'),
      walletBalance: { amount: balance, currency: record.currency.trim() },
      ledgerBalance: { amount: ledgerBalance, currency: record.currency.trim() },
      checkedAt: new Date().toISOString(),
    };
  }

  /** Used by the transaction use case: wallet is always loaded after acquiring its row lock. */
  static lockWallet(em: EntityManager, walletId: string) {
    return em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
  }
}

function encodeCursor(seq: string): string {
  return Buffer.from(seq, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^\d+$/.test(decoded) || Buffer.from(decoded, 'utf8').toString('base64url') !== cursor)
      throw new Error();
    return decoded;
  } catch {
    throw new InvalidCursorError();
  }
}

export class InvalidCursorError extends Error {}
