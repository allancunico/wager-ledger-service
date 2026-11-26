import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { v7 as uuidv7 } from 'uuid';
import { WalletService } from '../../src/application/wallets/wallet-service';
import { Money } from '../../src/domain/shared/money';
import { createTestDatabase } from '../integration/helpers/database';

describe('HTTP concurrency across service processes', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const children: Bun.Subprocess[] = [];
  let ports: number[];

  beforeAll(async () => {
    database = await createTestDatabase();
    ports = Array.from({ length: 3 }, () => randomPort());
    while (new Set(ports).size !== 3) ports = Array.from({ length: 3 }, () => randomPort());
    children.push(
      ...(await Promise.all(ports.map((port) => startApi(port, database.databaseUrl)))),
    );
  }, 45_000);

  afterAll(async () => {
    for (const child of children) {
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    await Promise.all(children.map((child) => child.exited));
    await database?.close();
  });

  test('three HTTP processes serialize competing debits on one wallet', async () => {
    const playerId = uuidv7();
    const wallet = await new WalletService(database.orm, { now: () => new Date() }).create({
      playerId,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
    });
    const requests = ports.map((port) => {
      const externalTransactionId = `process-${uuidv7()}`;
      return fetch(`http://127.0.0.1:${port}/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `key-${externalTransactionId}`,
        },
        body: JSON.stringify({
          providerId: 'http-process-it',
          externalTransactionId,
          playerId,
          walletId: wallet.id,
          roundId: uuidv7(),
          gameId: 'process-test',
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
        }),
      });
    });
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422, 422]);

    const finalWallet = await database.orm.em
      .fork()
      .execute<{ balance: string }[]>('select balance::text as balance from wallets where id = ?', [
        wallet.id,
      ]);
    expect(finalWallet[0]?.balance).toBe('20.00');
    const reconciliation = await fetch(
      `http://127.0.0.1:${ports[0]}/wallets/${wallet.id}/reconciliation`,
      { method: 'POST' },
    ).then((response) => response.json() as Promise<{ consistent: boolean }>);
    expect(reconciliation.consistent).toBe(true);
  }, 15_000);
});

async function startApi(port: number, databaseUrl: string): Promise<Bun.Subprocess> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const child = Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    env: { ...inherited, DATABASE_URL: databaseUrl, PORT: String(port), ROLES: 'api' },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (response.ok) return child;
    } catch {
      // Wait until Nest has bound this process's HTTP port.
    }
    await Bun.sleep(100);
  }
  child.kill('SIGTERM');
  await child.exited;
  throw new Error(`API na porta ${port} não ficou pronta`);
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}
