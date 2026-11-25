import { MikroORM } from '@mikro-orm/postgresql';
import {
  InboxMessageSchema,
  LedgerEntrySchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletSchema,
} from '../persistence/records';
import { migrationsList } from './migrations';

export async function createOrm(clientUrl = process.env.DATABASE_URL) {
  if (!clientUrl) throw new Error('DATABASE_URL é obrigatória para conectar ao PostgreSQL');
  return MikroORM.init({
    clientUrl,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      LedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    migrations: {
      migrationsList,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
      schema: 'public',
      tableName: 'mikro_orm_migrations',
    },
    driverOptions: { application_name: 'wager-ledger-service' },
  });
}
