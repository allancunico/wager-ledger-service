import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { NestFactory } from '@nestjs/core';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { ApplicationMetrics } from '../../src/application/observability/application-metrics';
import { logger } from '../../src/application/observability/logger';
import { DATABASE_ORM } from '../../src/infrastructure/di/tokens';
import { SqsTransactionConsumer } from '../../src/infrastructure/messaging/sqs-transaction-consumer';
import { ApiExceptionFilter } from '../../src/interfaces/http/api-exception.filter';
import { createTestDatabase } from './helpers/database';

describe('HTTP API', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let oldDatabaseUrl: string | undefined;
  let oldRoles: string | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    oldDatabaseUrl = process.env.DATABASE_URL;
    oldRoles = process.env.ROLES;
    process.env.DATABASE_URL = database.databaseUrl;
    process.env.ROLES = 'api';
    app = await NestFactory.create(AppModule, { logger: false });
    app.useGlobalFilters(app.get(ApiExceptionFilter));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('Servidor HTTP sem endereço TCP');
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    if (oldRoles === undefined) delete process.env.ROLES;
    else process.env.ROLES = oldRoles;
    await database?.close();
  });

  test('creates a wallet and serves an idempotent wager through HTTP', async () => {
    const playerId = uuidv7();
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    expect(created.status).toBe(201);
    const wallet = (await created.json()) as {
      id: string;
      walletId: string;
      balance: { amount: string };
    };
    expect(wallet.id).toBe(wallet.walletId);
    expect(wallet.balance.amount).toBe('100.00');

    const transactionBody = {
      providerId: 'http-test-provider',
      externalTransactionId: uuidv7(),
      playerId,
      walletId: wallet.walletId,
      roundId: uuidv7(),
      gameId: 'http-test-game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const headers = {
      'content-type': 'application/json',
      'idempotency-key': 'http-test-idempotency-key',
      'x-correlation-id': uuidv7(),
    };
    const first = await fetch(`${baseUrl}/wagering/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transactionBody),
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('x-correlation-id')).toBe(headers['x-correlation-id']);
    const firstBody = (await first.json()) as { status: string; transactionId: string };
    expect(firstBody.status).toBe('PROCESSED');

    // Existing route remains compatible and resolves to the same idempotent operation.
    const replay = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transactionBody),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

    const transactionById = await fetch(
      `${baseUrl}/wagering/transactions/${firstBody.transactionId}`,
    );
    expect(transactionById.status).toBe(200);
    expect(((await transactionById.json()) as { transactionId: string }).transactionId).toBe(
      firstBody.transactionId,
    );

    const transactionByProvider = await fetch(
      `${baseUrl}/providers/${transactionBody.providerId}/wagering/transactions/${transactionBody.externalTransactionId}`,
    );
    expect(transactionByProvider.status).toBe(200);
    expect(((await transactionByProvider.json()) as { transactionId: string }).transactionId).toBe(
      firstBody.transactionId,
    );

    const readWallet = await fetch(`${baseUrl}/wallets/${wallet.walletId}`);
    expect(readWallet.status).toBe(200);
    expect(((await readWallet.json()) as { balance: { amount: string } }).balance.amount).toBe(
      '75.00',
    );

    const reconciliation = await fetch(`${baseUrl}/wallets/${wallet.walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(reconciliation.status).toBe(200);
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: '75.00', currency: 'BRL' },
      calculatedBalance: { amount: '75.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      checkedEntries: 2,
    });
  });

  test('returns a problem response for invalid input', async () => {
    const response = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'missing-idempotency-header' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(((await response.json()) as { code: string }).code).toBe('INVALID_PAYLOAD');
  });

  test('exposes Prometheus metrics and checks both database and SQS readiness', async () => {
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);

    const response = await fetch(`${baseUrl}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const metrics = await response.text();
    expect(metrics).toContain('wager_transactions_total');
    expect(metrics).toContain('wager_outbox_pending_messages');
    expect(metrics).toContain('wager_dead_letter_queue_visible_messages');
  });

  test('logs and measures a reconciliation divergence without hiding it in the response', async () => {
    const created = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: uuidv7(),
        initialBalance: { amount: '10.00', currency: 'BRL' },
      }),
    });
    const wallet = (await created.json()) as { id: string };

    const orm = app.get<MikroORM>(DATABASE_ORM);
    await orm.em.fork().transactional(async (em) => {
      await em.execute('alter table wallets disable trigger wallet_balance_ledger_deferred');
      await em.execute(
        'update wallets set balance = balance + 1, version = version + 1 where id = ?',
        [wallet.id],
      );
      await em.execute('alter table wallets enable trigger wallet_balance_ledger_deferred');
    });

    const metricsSpy = spyOn(app.get(ApplicationMetrics), 'recordReconciliationMismatch');
    const loggerSpy = spyOn(logger, 'error');
    try {
      const response = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
        method: 'POST',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        consistent: false,
        difference: { amount: '1.00', currency: 'BRL' },
      });
      expect(metricsSpy).toHaveBeenCalledTimes(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          component: 'wallet-reconciliation',
          walletId: wallet.id,
          balanceMatches: false,
        }),
        'wallet balance and ledger disagree',
      );
    } finally {
      metricsSpy.mockRestore();
      loggerSpy.mockRestore();
    }
  });

  test('returns 503 when PostgreSQL is unavailable', async () => {
    const orm = app.get<MikroORM>(DATABASE_ORM);
    const entityManager = orm.em;
    const originalFork = entityManager.fork.bind(entityManager);
    entityManager.fork = (() => {
      throw new Error('simulated PostgreSQL outage');
    }) as typeof entityManager.fork;

    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        retryable: true,
      });
    } finally {
      entityManager.fork = originalFork;
    }
  });

  test('returns 503 when SQS is unavailable', async () => {
    const consumer = app.get(SqsTransactionConsumer);
    const originalCheckReady = consumer.checkReady.bind(consumer);
    consumer.checkReady = async () => {
      throw new Error('simulated SQS outage');
    };

    try {
      const response = await fetch(`${baseUrl}/health/ready`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        retryable: true,
      });
    } finally {
      consumer.checkReady = originalCheckReady;
    }
  });
});
