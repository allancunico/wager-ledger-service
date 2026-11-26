import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { v7 as uuidv7 } from 'uuid';
import { createTestDatabase } from './helpers/database';

const enabled = Boolean(process.env.TEST_DATABASE_ADMIN_URL || process.env.DATABASE_URL);
let orm: MikroORM | undefined;
let cleanup: (() => Promise<void>) | undefined;

function getOrm(): MikroORM {
  if (!orm) throw new Error('Banco de teste não foi inicializado');
  return orm;
}

describe.skipIf(!enabled)('MikroORM migrations', () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    orm = database.orm;
    cleanup = database.close;
  }, 30_000);

  afterAll(async () => cleanup?.());

  test('migrations are ordered and up is idempotent', async () => {
    const migrator = getOrm().migrator;
    const executed = await migrator.getStorage().executed();
    expect(await migrator.getPending()).toHaveLength(0);
    expect(executed).toHaveLength(7);
    expect(new Set(executed).size).toBe(7);
    expect(executed).toEqual([...executed].sort());
    await migrator.up();
    expect(await migrator.getStorage().executed()).toHaveLength(7);
  });

  test('down reverts one migration and down to zero removes project schema objects', async () => {
    const migrator = getOrm().migrator;
    const eventIds = [uuidv7(), uuidv7()];
    for (const eventId of eventIds) {
      await getOrm()
        .em.fork()
        .execute(
          `insert into outbox_messages
           (id, aggregate_id, group_key, event_type, payload, occurred_at, attempts)
         values (?, ?, ?, 'MigrationProbe', ?::jsonb, now(), 0)`,
          [eventId, uuidv7(), uuidv7(), JSON.stringify({ eventId })],
        );
    }
    await migrator.down();
    expect(await migrator.getStorage().executed()).toHaveLength(6);
    await migrator.up();
    expect(await migrator.getStorage().executed()).toHaveLength(7);
    const backfill = await getOrm()
      .em.getConnection()
      .execute<{ total: string; populated: string; uniqueSeqs: string; claimed: string }[]>(
        `select count(*)::text as total, count(seq)::text as populated,
                count(distinct seq)::text as "uniqueSeqs", count(claim_token)::text as claimed
           from outbox_messages`,
      );
    expect(backfill).toEqual([{ total: '2', populated: '2', uniqueSeqs: '2', claimed: '0' }]);

    await migrator.down({ to: 0 });
    const tables = await getOrm()
      .em.getConnection()
      .execute<{ table_name: string }[]>(
        `select table_name from information_schema.tables where table_schema = current_schema() and table_name = 'wallets'`,
      );
    const functions = await getOrm()
      .em.getConnection()
      .execute<{ proname: string }[]>(
        `select proname from pg_proc join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
       where nspname = current_schema() and proname in ('forbid_truncate','enforce_wallet_version','assert_wallet_matches_ledger','assert_transaction_matches_ledger')`,
      );
    expect(tables).toHaveLength(0);
    expect(functions).toHaveLength(0);
    expect(await migrator.getStorage().executed()).toHaveLength(0);

    await migrator.up();
    expect(await migrator.getStorage().executed()).toHaveLength(7);
  });
});
