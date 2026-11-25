import { SQL } from 'bun';
import { createOrm } from '../../../src/infrastructure/database/orm';

export async function createTestDatabase() {
  const sourceUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!sourceUrl) {
    throw new Error('Defina TEST_DATABASE_ADMIN_URL ou DATABASE_URL para os testes de integração');
  }

  const adminUrl = new URL(sourceUrl);
  const databaseName = `wager_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(sourceUrl);
  const admin = new SQL(adminUrl.toString());
  try {
    await admin.unsafe(`create database "${databaseName}" template template0`);
  } finally {
    await admin.close();
  }

  databaseUrl.pathname = `/${databaseName}`;
  let orm: Awaited<ReturnType<typeof createOrm>> | undefined;
  try {
    orm = await createOrm(databaseUrl.toString());
    await orm.migrator.up();
  } catch (error) {
    await orm?.close(true);
    await dropTestDatabase(adminUrl.toString(), databaseName);
    throw error;
  }

  if (!orm) throw new Error('ORM não foi inicializado para o banco de teste');

  return {
    orm,
    async close() {
      await orm.close(true);
      await dropTestDatabase(adminUrl.toString(), databaseName);
    },
  };
}

async function dropTestDatabase(adminUrl: string, databaseName: string): Promise<void> {
  const admin = new SQL(adminUrl);
  try {
    await admin.unsafe(
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${databaseName}' and pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`drop database if exists "${databaseName}"`);
  } finally {
    await admin.close();
  }
}
