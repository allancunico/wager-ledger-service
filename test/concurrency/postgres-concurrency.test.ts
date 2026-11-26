import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { WagerTransactionService } from '../../src/application/wagering/wager-transaction-service';
import { WalletService } from '../../src/application/wallets/wallet-service';
import { Money } from '../../src/domain/shared/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { loadEnv } from '../../src/infrastructure/config/env';
import { createOrm } from '../../src/infrastructure/database/orm';
import {
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
} from '../../src/infrastructure/persistence/records';
import { createTestDatabase } from '../integration/helpers/database';

describe('PostgreSQL concurrency across independent service instances', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let secondOrm: Awaited<ReturnType<typeof createOrm>>;
  let thirdOrm: Awaited<ReturnType<typeof createOrm>>;
  let walletsA: WalletService;
  let transactionsA: WagerTransactionService;
  let transactionsB: WagerTransactionService;
  let transactionsC: WagerTransactionService;

  beforeAll(async () => {
    database = await createTestDatabase();
    secondOrm = await createOrm(database.databaseUrl);
    thirdOrm = await createOrm(database.databaseUrl);
    const env = loadEnv();
    const clock = { now: () => new Date('2026-11-25T12:00:00.000Z') };
    walletsA = new WalletService(database.orm, clock);
    transactionsA = new WagerTransactionService(database.orm, clock, env);
    transactionsB = new WagerTransactionService(secondOrm, clock, env);
    transactionsC = new WagerTransactionService(thirdOrm, clock, env);
  }, 30_000);

  afterAll(async () => {
    await thirdOrm?.close(true);
    await secondOrm?.close(true);
    await database?.close();
  });

  test('two concurrent debits cannot overspend a wallet', async () => {
    const playerId = uuidv7();
    const wallet = await walletsA.create({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const firstInput = wagerInput(playerId, wallet.id, '80.00');
    const secondInput = wagerInput(playerId, wallet.id, '80.00');

    const [first, second] = await Promise.all([
      transactionsA.submit(firstInput),
      transactionsB.submit(secondInput),
    ]);
    const results = [first, second];
    const storedWallet = await walletsA.get(wallet.id);
    const reconciliation = await walletsA.reconcile(wallet.id);

    expect(results.map((result) => result.httpStatus).sort()).toEqual([201, 422]);
    expect(
      results.filter((result) => result.body.failureCode === 'INSUFFICIENT_FUNDS'),
    ).toHaveLength(1);
    expect(storedWallet.balance.amount).toBe('20.00');
    expect(storedWallet.version).toBe(2);
    expect(await database.orm.em.fork().count(LedgerEntryRecord, { walletId: wallet.id })).toBe(2);
    expect(
      await database.orm.em.fork().count(WagerTransactionRecord, { walletId: wallet.id }),
    ).toBe(3);
    expect(await database.orm.em.fork().count(OutboxMessageRecord, { groupKey: wallet.id })).toBe(
      5,
    );
    expect(reconciliation.consistent).toBe(true);
    expect(reconciliation.chainConsistent).toBe(true);
  });

  test('50 parallel deliveries across three service instances apply one debit', async () => {
    const playerId = uuidv7();
    const wallet = await walletsA.create({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const input = wagerInput(playerId, wallet.id, '15.00');
    const results = await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const service =
          index % 3 === 0 ? transactionsA : index % 3 === 1 ? transactionsB : transactionsC;
        return service.submit(input);
      }),
    );
    const transactionIds = new Set(results.map((result) => result.body.transactionId));
    const storedWallet = await walletsA.get(wallet.id);

    expect(results.filter((result) => result.httpStatus === 201)).toHaveLength(1);
    expect(results.filter((result) => result.httpStatus === 200)).toHaveLength(49);
    expect(transactionIds.size).toBe(1);
    expect(storedWallet.balance.amount).toBe('85.00');
    expect(storedWallet.version).toBe(2);
    expect(await database.orm.em.fork().count(LedgerEntryRecord, { walletId: wallet.id })).toBe(2);
    expect(
      await database.orm.em.fork().count(WagerTransactionRecord, { walletId: wallet.id }),
    ).toBe(2);
    expect((await walletsA.reconcile(wallet.id)).consistent).toBe(true);
    expect(await database.orm.em.fork().count(OutboxMessageRecord, { groupKey: wallet.id })).toBe(
      4,
    );
  });

  test('different wallets process transactions concurrently and reconcile independently', async () => {
    const firstPlayerId = uuidv7();
    const secondPlayerId = uuidv7();
    const [firstWallet, secondWallet] = await Promise.all([
      walletsA.create({
        playerId: firstPlayerId,
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      }),
      walletsA.create({
        playerId: secondPlayerId,
        initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      }),
    ]);

    const results = await Promise.all([
      transactionsA.submit(wagerInput(firstPlayerId, firstWallet.id, '10.00')),
      transactionsC.submit(wagerInput(secondPlayerId, secondWallet.id, '25.00')),
    ]);
    const [savedFirstWallet, savedSecondWallet] = await Promise.all([
      walletsA.get(firstWallet.id),
      walletsA.get(secondWallet.id),
    ]);

    expect(results.map((result) => result.httpStatus)).toEqual([201, 201]);
    expect(savedFirstWallet.balance.amount).toBe('90.00');
    expect(savedSecondWallet.balance.amount).toBe('75.00');
    expect((await walletsA.reconcile(firstWallet.id)).consistent).toBe(true);
    expect((await walletsA.reconcile(secondWallet.id)).consistent).toBe(true);
  });
});

function wagerInput(playerId: string, walletId: string, amount: string) {
  const externalTransactionId = uuidv7();
  return {
    providerId: 'concurrency-test-provider',
    externalTransactionId,
    idempotencyKey: `key:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: uuidv7(),
    gameId: 'concurrency-test-game',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: 'BRL' }),
    correlationId: uuidv7(),
  };
}
