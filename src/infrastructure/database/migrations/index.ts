import { Migration20261124000001CreateWallets } from './Migration20261124000001CreateWallets';
import { Migration20261124000002CreateWagerTransactions } from './Migration20261124000002CreateWagerTransactions';
import { Migration20261124000003CreateWalletLedgerEntries } from './Migration20261124000003CreateWalletLedgerEntries';
import { Migration20261124000004CreateMessaging } from './Migration20261124000004CreateMessaging';
import { Migration20261124000005EnforceLedgerInvariants } from './Migration20261124000005EnforceLedgerInvariants';

export const migrationsList = [
  Migration20261124000001CreateWallets,
  Migration20261124000002CreateWagerTransactions,
  Migration20261124000003CreateWalletLedgerEntries,
  Migration20261124000004CreateMessaging,
  Migration20261124000005EnforceLedgerInvariants,
];
