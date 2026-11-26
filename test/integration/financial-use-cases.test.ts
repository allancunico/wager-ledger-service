import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import {
  IdempotencyConflictError,
  WagerTransactionService,
} from '../../src/application/wagering/wager-transaction-service';
import { WalletService } from '../../src/application/wallets/wallet-service';
import { Money } from '../../src/domain/shared/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { loadEnv } from '../../src/infrastructure/config/env';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
} from '../../src/infrastructure/persistence/records';
import { createTestDatabase } from './helpers/database';

describe('financial use cases', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let wallets: WalletService;
  let transactions: WagerTransactionService;

  beforeAll(async () => {
    database = await createTestDatabase();
    const env = loadEnv();
    const clock = { now: () => new Date('2026-11-25T12:00:00.000Z') };
    wallets = new WalletService(database.orm, clock);
    transactions = new WagerTransactionService(database.orm, clock, env);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  test('creates wallet, opening ledger, applies a bet atomically, and replays once', async () => {
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });

    expect(wallet.balance.amount).toBe('100.00');
    expect(await database.orm.em.fork().count(LedgerEntryRecord, { walletId: wallet.id })).toBe(1);

    const input = wagerInput({ playerId, walletId: wallet.id });
    const first = await transactions.submit(input);
    const replay = await transactions.submit(input);
    const savedWallet = await wallets.get(wallet.id);

    expect(first.httpStatus).toBe(201);
    expect(first.body.status).toBe('PROCESSED');
    expect(replay.httpStatus).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(savedWallet.balance.amount).toBe('80.00');
    expect(savedWallet.version).toBe(2);
    expect(await database.orm.em.fork().count(LedgerEntryRecord, { walletId: wallet.id })).toBe(2);
    expect(
      await database.orm.em.fork().count(OutboxMessageRecord, {
        aggregateId: first.body.transactionId as string,
      }),
    ).toBe(1);
    expect(
      await database.orm.em.fork().count(OutboxMessageRecord, { aggregateId: wallet.id }),
    ).toBe(2);

    const firstPage = await wallets.getLedger(wallet.id, 1);
    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await wallets.getLedger(wallet.id, 1, firstPage.nextCursor ?? undefined);
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('rejects reused key with changed payload and persists a business rejection', async () => {
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '5.00', currency: 'BRL' }),
    });
    const input = wagerInput({
      playerId,
      walletId: wallet.id,
      externalTransactionId: uuidv7(),
      idempotencyKey: uuidv7(),
    });

    const rejected = await transactions.submit(input);
    expect(rejected.httpStatus).toBe(422);
    await expect(
      transactions.submit({ ...input, money: Money.from({ amount: '6.00', currency: 'BRL' }) }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(rejected.httpStatus).toBe(422);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await wallets.get(wallet.id)).balance.amount).toBe('5.00');
    expect(
      await database.orm.em.fork().count(WagerTransactionRecord, {
        walletId: wallet.id,
        status: 'REJECTED',
      }),
    ).toBe(1);
  });

  test('keeps a transaction with an unknown reference pending and returns 202', async () => {
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const result = await transactions.submit(
      wagerInput({
        playerId,
        walletId: wallet.id,
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: uuidv7(),
      }),
    );
    expect(result.httpStatus).toBe(202);
    expect(result.body.status).toBe('PENDING_REFERENCE');
    expect(
      await database.orm.em.fork().count(OutboxMessageRecord, {
        aggregateId: result.body.transactionId as string,
      }),
    ).toBe(1);
  });

  test('rolls back inbox, transaction, balance, ledger, and outbox when persistence fails mid-flight', async () => {
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const input = wagerInput({
      playerId,
      walletId: wallet.id,
      externalTransactionId: uuidv7(),
    });
    const consumerName = 'atomicity-integration-test';
    const messageId = uuidv7();
    const em = database.orm.em.fork();
    const ledgerBefore = await em.count(LedgerEntryRecord, { walletId: wallet.id });
    const outboxBefore = await em.count(OutboxMessageRecord, { groupKey: wallet.id });

    await em.execute(`
      create function fail_target_outbox_for_test() returns trigger language plpgsql as $$
      begin
        if new.payload #>> '{data,externalTransactionId}' = '${input.externalTransactionId}' then
          raise exception 'forced outbox persistence failure';
        end if;
        return new;
      end;
      $$;
      create trigger fail_target_outbox_for_test
        before insert on outbox_messages
        for each row execute function fail_target_outbox_for_test();
    `);

    try {
      await expect(
        transactions.submitFromQueue(input, { consumerName, messageId }),
      ).rejects.toThrow('forced outbox persistence failure');
    } finally {
      await em.execute('drop trigger if exists fail_target_outbox_for_test on outbox_messages');
      await em.execute('drop function if exists fail_target_outbox_for_test()');
    }

    const savedWallet = await wallets.get(wallet.id);
    expect(savedWallet.balance.amount).toBe('100.00');
    expect(savedWallet.version).toBe(1);
    expect(await em.count(LedgerEntryRecord, { walletId: wallet.id })).toBe(ledgerBefore);
    expect(await em.count(OutboxMessageRecord, { groupKey: wallet.id })).toBe(outboxBefore);
    expect(await em.count(InboxMessageRecord, { consumerName, messageId })).toBe(0);
    expect(
      await em.count(WagerTransactionRecord, {
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
      }),
    ).toBe(0);
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });

  test('allows one REFUND and one ROLLBACK per reference, but rejects duplicates of each kind', async () => {
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    const betExternalId = uuidv7();
    const roundId = uuidv7();
    const bet = await transactions.submit(
      wagerInput({
        playerId,
        walletId: wallet.id,
        externalTransactionId: betExternalId,
        roundId,
        kind: WagerTransactionKind.Bet,
      }),
    );
    expect(bet.httpStatus).toBe(201);

    const refund = await transactions.submit(
      wagerInput({
        playerId,
        walletId: wallet.id,
        roundId,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    const rollback = await transactions.submit(
      wagerInput({
        playerId,
        walletId: wallet.id,
        roundId,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    const duplicateRefund = await transactions.submit(
      wagerInput({
        playerId,
        walletId: wallet.id,
        roundId,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: betExternalId,
      }),
    );
    const duplicateRollback = await transactions.submit(
      wagerInput({
        playerId,
        walletId: wallet.id,
        roundId,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: betExternalId,
      }),
    );

    expect(refund.body.status).toBe('PROCESSED');
    expect(rollback.body.status).toBe('PROCESSED');
    expect(duplicateRefund.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect(duplicateRollback.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
    expect((await wallets.get(wallet.id)).balance.amount).toBe('70.00');
    expect((await wallets.reconcile(wallet.id)).consistent).toBe(true);
  });
});

function wagerInput(overrides: {
  playerId: string;
  walletId: string;
  kind?: WagerTransactionKind;
  externalTransactionId?: string;
  idempotencyKey?: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
}) {
  const externalTransactionId = overrides.externalTransactionId ?? uuidv7();
  return {
    providerId: 'integration-test-provider',
    externalTransactionId,
    idempotencyKey: overrides.idempotencyKey ?? `key:${externalTransactionId}`,
    playerId: overrides.playerId,
    walletId: overrides.walletId,
    roundId: overrides.roundId ?? uuidv7(),
    gameId: 'integration-game',
    kind: overrides.kind ?? WagerTransactionKind.Bet,
    money: Money.from({ amount: '20.00', currency: 'BRL' }),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    correlationId: uuidv7(),
  };
}
