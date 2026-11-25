import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { v7 as uuidv7 } from 'uuid';
import { AppModule } from '../../src/app.module';
import { ApiExceptionFilter } from '../../src/interfaces/http/api-exception.filter';
import { createTestDatabase } from './helpers/database';

describe('HTTP API', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let oldDatabaseUrl: string | undefined;

  beforeAll(async () => {
    database = await createTestDatabase();
    oldDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.databaseUrl;
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
    const wallet = (await created.json()) as { walletId: string; balance: { amount: string } };
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
    const first = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transactionBody),
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('x-correlation-id')).toBe(headers['x-correlation-id']);
    expect(((await first.json()) as { status: string }).status).toBe('PROCESSED');

    const replay = await fetch(`${baseUrl}/transactions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(transactionBody),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

    const readWallet = await fetch(`${baseUrl}/wallets/${wallet.walletId}`);
    expect(readWallet.status).toBe(200);
    expect(((await readWallet.json()) as { balance: { amount: string } }).balance.amount).toBe(
      '75.00',
    );

    const reconciliation = await fetch(`${baseUrl}/wallets/${wallet.walletId}/reconciliation`, {
      method: 'POST',
    });
    expect(reconciliation.status).toBe(200);
    expect(((await reconciliation.json()) as { consistent: boolean }).consistent).toBe(true);
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
});
