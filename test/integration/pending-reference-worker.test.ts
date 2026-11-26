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
  WalletRecord,
} from '../../src/infrastructure/persistence/records';
import { createTestDatabase } from './helpers/database';

let testDatabaseRef: Awaited<ReturnType<typeof createTestDatabase>>;

describe('pending reference worker', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let secondOrm: Awaited<ReturnType<typeof createOrm>>;
  let env: ReturnType<typeof loadEnv>;

  beforeAll(async () => {
    database = await createTestDatabase();
    testDatabaseRef = database;
    secondOrm = await createOrm(database.databaseUrl);
    env = loadEnv({
      ...process.env,
      PENDING_REFERENCE_TTL_SECONDS: '60',
      PENDING_REFERENCE_BACKOFF_BASE_SECONDS: '5',
      PENDING_REFERENCE_BACKOFF_MAX_SECONDS: '30',
    });
  }, 30_000);

  afterAll(async () => {
    await secondOrm?.close(true);
    await database?.close();
  });

  test('processes a pending transaction after its reference arrives and writes financial effects once', async () => {
    const clock = new MutableClock();
    const { wallets, transactions } = services(database.orm, env, clock);
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '50.00', currency: 'BRL' }),
    });
    const betExternalId = `bet-${uuidv7()}`;
    const roundId = `round-${uuidv7()}`;
    const pendingInput = input({
      playerId,
      walletId: wallet.id,
      roundId,
      kind: WagerTransactionKind.Win,
      amount: '12.00',
      referenceExternalTransactionId: betExternalId,
    });

    const pending = await transactions.submit(pendingInput);
    expect(pending.httpStatus).toBe(202);
    expect(pending.body.status).toBe('PENDING_REFERENCE');
    expect(await transactions.reprocessPendingReferences(10)).toBe(0);

    const betInput = input({
      playerId,
      walletId: wallet.id,
      roundId,
      externalTransactionId: betExternalId,
      kind: WagerTransactionKind.Bet,
      amount: '10.00',
    });
    expect((await transactions.submit(betInput)).httpStatus).toBe(201);
    clock.advance(10_000);

    expect(await transactions.reprocessPendingReferences(10)).toBe(1);
    expect(await transactions.reprocessPendingReferences(10)).toBe(0);
    const saved = await database.orm.em.fork().findOneOrFail(WagerTransactionRecord, {
      providerId: pendingInput.providerId,
      externalTransactionId: pendingInput.externalTransactionId,
    });
    expect(saved.status).toBe('PROCESSED');
    expect(saved.referenceTransactionId).toBeDefined();
    expect(await readBalance(wallet.id)).toBe('52.00');
    expect(await ledgerCount(wallet.id)).toBe(3);
    expect(
      await database.orm.em.fork().count(OutboxMessageRecord, {
        aggregateId: pending.body.transactionId as string,
      }),
    ).toBe(2);
  }, 15_000);

  test('rejects an unresolved reference at TTL with REFERENCE_NOT_FOUND and no balance change', async () => {
    const clock = new MutableClock();
    const { wallets, transactions } = services(database.orm, env, clock);
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '25.00', currency: 'BRL' }),
    });
    const pendingInput = input({
      playerId,
      walletId: wallet.id,
      kind: WagerTransactionKind.Win,
      amount: '8.00',
      referenceExternalTransactionId: `missing-${uuidv7()}`,
    });
    const pending = await transactions.submit(pendingInput);
    expect(pending.body.status).toBe('PENDING_REFERENCE');

    clock.advance(60_000);
    expect(await transactions.reprocessPendingReferences(10)).toBe(1);

    const saved = await database.orm.em.fork().findOneOrFail(WagerTransactionRecord, {
      providerId: pendingInput.providerId,
      externalTransactionId: pendingInput.externalTransactionId,
    });
    expect(saved.status).toBe('REJECTED');
    expect(saved.failureCode).toBe('REFERENCE_NOT_FOUND');
    expect(await readBalance(wallet.id)).toBe('25.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(
      await database.orm.em.fork().count(OutboxMessageRecord, {
        aggregateId: pending.body.transactionId as string,
      }),
    ).toBe(2);
  }, 15_000);

  test('expires a dependent transaction as REFERENCE_NOT_PROCESSED when its reference is still pending', async () => {
    const clock = new MutableClock();
    const { wallets, transactions } = services(database.orm, env, clock);
    const playerId = uuidv7();
    const wallet = await wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '40.00', currency: 'BRL' }),
    });
    const roundId = `round-${uuidv7()}`;
    const unresolvedWin = input({
      playerId,
      walletId: wallet.id,
      roundId,
      kind: WagerTransactionKind.Win,
      amount: '10.00',
      referenceExternalTransactionId: `missing-${uuidv7()}`,
    });
    expect((await transactions.submit(unresolvedWin)).body.status).toBe('PENDING_REFERENCE');

    const dependentRollback = input({
      playerId,
      walletId: wallet.id,
      roundId,
      kind: WagerTransactionKind.Rollback,
      amount: '10.00',
      referenceExternalTransactionId: unresolvedWin.externalTransactionId,
    });
    expect((await transactions.submit(dependentRollback)).body.status).toBe('PENDING_REFERENCE');

    clock.advance(60_000);
    expect(await transactions.reprocessPendingReferences(10)).toBe(2);
    const rows = await database.orm.em.fork().find(WagerTransactionRecord, {
      providerId: unresolvedWin.providerId,
      walletId: wallet.id,
      status: 'REJECTED',
    });
    expect(rows.map((row) => row.failureCode).sort()).toEqual([
      'REFERENCE_NOT_FOUND',
      'REFERENCE_NOT_PROCESSED',
    ]);
    expect(await readBalance(wallet.id)).toBe('40.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
  }, 15_000);

  test('two service instances reprocess one due item without duplicating its credit or ledger entry', async () => {
    const clock = new MutableClock();
    const first = services(database.orm, env, clock);
    const second = services(secondOrm, env, clock);
    const playerId = uuidv7();
    const wallet = await first.wallets.create({
      playerId,
      initialBalance: Money.from({ amount: '30.00', currency: 'BRL' }),
    });
    const betExternalId = `bet-${uuidv7()}`;
    const roundId = `round-${uuidv7()}`;
    const pendingInput = input({
      playerId,
      walletId: wallet.id,
      roundId,
      kind: WagerTransactionKind.Win,
      amount: '7.00',
      referenceExternalTransactionId: betExternalId,
    });
    expect((await first.transactions.submit(pendingInput)).body.status).toBe('PENDING_REFERENCE');
    await first.transactions.submit(
      input({
        playerId,
        walletId: wallet.id,
        roundId,
        externalTransactionId: betExternalId,
        kind: WagerTransactionKind.Bet,
        amount: '5.00',
      }),
    );
    clock.advance(10_000);

    const counts = await Promise.all([
      first.transactions.reprocessPendingReferences(10),
      second.transactions.reprocessPendingReferences(10),
    ]);
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await readBalance(wallet.id)).toBe('32.00');
    expect(await ledgerCount(wallet.id)).toBe(3);
    expect(await first.wallets.reconcile(wallet.id)).toMatchObject({
      consistent: true,
      chainConsistent: true,
    });
  }, 15_000);
});

function services(
  orm: Awaited<ReturnType<typeof createOrm>>,
  env: ReturnType<typeof loadEnv>,
  clock: MutableClock,
) {
  return {
    wallets: new WalletService(orm, clock),
    transactions: new WagerTransactionService(orm, clock, env),
  };
}

function input(overrides: {
  playerId: string;
  walletId: string;
  roundId?: string;
  kind: WagerTransactionKind;
  amount: string;
  externalTransactionId?: string;
  referenceExternalTransactionId?: string;
}) {
  const externalTransactionId = overrides.externalTransactionId ?? `tx-${uuidv7()}`;
  return {
    providerId: 'pending-reference-it',
    externalTransactionId,
    idempotencyKey: `key-${externalTransactionId}`,
    playerId: overrides.playerId,
    walletId: overrides.walletId,
    roundId: overrides.roundId ?? `round-${uuidv7()}`,
    gameId: 'worker-it',
    kind: overrides.kind,
    money: Money.from({ amount: overrides.amount, currency: 'BRL' }),
    referenceExternalTransactionId: overrides.referenceExternalTransactionId,
    correlationId: uuidv7(),
  };
}

async function readBalance(walletId: string): Promise<string> {
  const wallet = await testDatabaseRef.orm.em.fork().findOneOrFail(WalletRecord, { id: walletId });
  return wallet.balance;
}

async function ledgerCount(walletId: string): Promise<number> {
  return testDatabaseRef.orm.em.fork().count(LedgerEntryRecord, { walletId });
}

class MutableClock {
  private current = new Date('2026-11-25T12:00:00.000Z');

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
