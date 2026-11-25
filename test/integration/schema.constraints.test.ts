import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createTestDatabase } from './helpers/database';

const enabled = Boolean(process.env.TEST_DATABASE_ADMIN_URL || process.env.DATABASE_URL);
let orm: MikroORM | undefined;
let cleanup: (() => Promise<void>) | undefined;

function getOrm(): MikroORM {
  if (!orm) throw new Error('Banco de teste não foi inicializado');
  return orm;
}

async function expectDatabaseFailure(action: () => Promise<unknown>) {
  await expect(action()).rejects.toThrow();
}

async function insertWallet(
  em: NonNullable<typeof orm>['em'],
  {
    id = crypto.randomUUID(),
    player = crypto.randomUUID(),
    currency = 'BRL',
    balance = '0.00',
  } = {},
) {
  await em.execute(
    'insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values (?, ?, ?, ?, 1, now(), now())',
    [id, player, currency, balance],
  );
  return id;
}

async function insertTransaction(
  em: NonNullable<typeof orm>['em'],
  walletId: string,
  {
    id = crypto.randomUUID(),
    provider = crypto.randomUUID(),
    key = crypto.randomUUID(),
    external = crypto.randomUUID(),
    kind = 'BET',
    status = 'PENDING',
    amount = '1.00',
    referenceId = null,
    referenceExternalId = null,
  }: {
    id?: string;
    provider?: string;
    key?: string;
    external?: string;
    kind?: string;
    status?: string;
    amount?: string;
    referenceId?: string | null;
    referenceExternalId?: string | null;
  } = {},
) {
  await em.execute(
    `insert into wager_transactions
      (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
       round_id, game_id, kind, amount, currency, reference_external_transaction_id,
       reference_transaction_id, status, created_at, reference_attempts)
     values (?, ?, ?, ?, ?, ?, (select player_id from wallets where id = ?), 'round', 'game', ?, ?, 'BRL', ?, ?, ?, now(), 0)`,
    [
      id,
      provider,
      external,
      key,
      'a'.repeat(64),
      walletId,
      walletId,
      kind,
      amount,
      referenceExternalId,
      referenceId,
      status,
    ],
  );
  return id;
}

async function insertLedger(
  em: NonNullable<typeof orm>['em'],
  walletId: string,
  transactionId: string,
  { direction = 'CREDIT', amount = '1.00', before = '0.00', after = '1.00' } = {},
) {
  await em.execute(
    `insert into wallet_ledger_entries
      (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
     values (?, ?, ?, ?, ?, 'BRL', ?, ?, now())`,
    [crypto.randomUUID(), walletId, transactionId, direction, amount, before, after],
  );
}

describe.skipIf(!enabled)('PostgreSQL schema constraints', () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    orm = database.orm;
    cleanup = database.close;
  }, 30_000);

  afterAll(async () => cleanup?.());

  test('wallet unique, nonnegative balance, currency, and version guards', async () => {
    const em = getOrm().em;
    const playerId = crypto.randomUUID();
    await em.transactional((tx) => insertWallet(tx, { player: playerId }));
    await expectDatabaseFailure(() =>
      em.transactional((tx) => insertWallet(tx, { player: playerId })),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) => insertWallet(tx, { balance: '-0.01' })),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) => insertWallet(tx, { currency: 'brl' })),
    );
    const walletId = await em.transactional((tx) => insertWallet(tx));
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        tx.execute('update wallets set version = version + 1 where id = ?', [walletId]),
      ),
    );
  });

  test('transaction idempotency and external id are unique; refund requires reference', async () => {
    const em = getOrm().em;
    const walletId = await em.transactional((tx) => insertWallet(tx));
    const provider = crypto.randomUUID();
    const key = crypto.randomUUID();
    const external = crypto.randomUUID();
    await em.transactional((tx) => insertTransaction(tx, walletId, { provider, key, external }));
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        insertTransaction(tx, walletId, { provider, key, external: crypto.randomUUID() }),
      ),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        insertTransaction(tx, walletId, {
          provider,
          key: crypto.randomUUID(),
          external,
        }),
      ),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        insertTransaction(tx, walletId, { kind: 'REFUND', referenceExternalId: null }),
      ),
    );
  });

  test('processed balance transactions require a matching ledger entry at commit', async () => {
    const em = getOrm().em;
    await expectDatabaseFailure(() =>
      em.transactional(async (tx) => {
        const walletId = await insertWallet(tx);
        await insertTransaction(tx, walletId, { status: 'PROCESSED' });
      }),
    );
  });

  test('only one processed refund or rollback can reverse a transaction', async () => {
    const em = getOrm().em;
    await expectDatabaseFailure(() =>
      em.transactional(async (tx) => {
        const walletId = await insertWallet(tx, { balance: '2.00' });
        const referenceId = await insertTransaction(tx, walletId, {
          kind: 'LOSS',
          status: 'PROCESSED',
        });
        const provider = crypto.randomUUID();
        await insertTransaction(tx, walletId, {
          provider,
          kind: 'REFUND',
          status: 'PROCESSED',
          referenceId,
          referenceExternalId: 'loss-ref',
        });
        await insertTransaction(tx, walletId, {
          provider,
          kind: 'ROLLBACK',
          status: 'PROCESSED',
          referenceId,
          referenceExternalId: 'loss-ref',
        });
      }),
    );
  });

  test('terminal transactions cannot be changed', async () => {
    const em = getOrm().em;
    const walletId = await em.transactional((tx) => insertWallet(tx));
    const transactionId = await em.transactional((tx) =>
      insertTransaction(tx, walletId, { status: 'REJECTED' }),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        tx.execute("update wager_transactions set status = 'PROCESSED' where id = ?", [
          transactionId,
        ]),
      ),
    );
  });

  test('wallet balance must equal the final ledger balance at commit', async () => {
    await expectDatabaseFailure(() =>
      getOrm().em.transactional((tx) => insertWallet(tx, { balance: '10.00' })),
    );
  });

  test('ledger rejects arithmetic and chain breaks, and blocks updates and truncation', async () => {
    const em = getOrm().em;
    const walletId = await em.transactional((tx) => insertWallet(tx));
    const transactionId = await em.transactional((tx) => insertTransaction(tx, walletId));
    await em.transactional(async (tx) => {
      await tx.execute(
        "update wager_transactions set status = 'PROCESSED', resolved_at = now(), balance_snapshot = '1.00', balance_snapshot_currency = 'BRL' where id = ?",
        [transactionId],
      );
      await tx.execute('update wallets set balance = ?, version = version + 1 where id = ?', [
        '1.00',
        walletId,
      ]);
      await insertLedger(tx, walletId, transactionId);
    });

    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        tx.execute('update wallet_ledger_entries set amount = ? where transaction_id = ?', [
          '2.00',
          transactionId,
        ]),
      ),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) => tx.execute('truncate wallet_ledger_entries')),
    );

    const nextTransactionId = await em.transactional((tx) =>
      insertTransaction(tx, walletId, { status: 'PENDING' }),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        insertLedger(tx, walletId, nextTransactionId, { before: '0.00', after: '1.00' }),
      ),
    );
    await expectDatabaseFailure(() =>
      em.transactional((tx) =>
        insertLedger(tx, walletId, nextTransactionId, { before: '1.00', after: '3.00' }),
      ),
    );
  });

  test('inbox deduplicates a consumer message id', async () => {
    const em = getOrm().em;
    const row = ['consumer', crypto.randomUUID(), 'b'.repeat(64)];
    const insert = (tx: typeof em) =>
      tx.execute(
        'insert into inbox_messages (consumer_name, message_id, payload_hash, received_at) values (?, ?, ?, now())',
        row,
      );
    await em.transactional(insert);
    await expectDatabaseFailure(() => em.transactional(insert));
  });

  test('pending outbox event cannot be deleted', async () => {
    const em = getOrm().em;
    await expectDatabaseFailure(() =>
      em.transactional(async (tx) => {
        const id = crypto.randomUUID();
        await tx.execute(
          `insert into outbox_messages (id, aggregate_id, group_key, event_type, payload, occurred_at, attempts)
           values (?, ?, ?, 'event', ?::jsonb, now(), 0)`,
          [id, crypto.randomUUID(), crypto.randomUUID(), JSON.stringify({ eventId: id })],
        );
        await tx.execute('delete from outbox_messages where id = ?', [id]);
      }),
    );
  });
});
