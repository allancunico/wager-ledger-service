import { Migration20261124000001CreateWallets } from './Migration20261124000001CreateWallets';
import { Migration20261124000002CreateWagerTransactions } from './Migration20261124000002CreateWagerTransactions';
import { Migration20261124000003CreateWalletLedgerEntries } from './Migration20261124000003CreateWalletLedgerEntries';
import { Migration20261124000004CreateMessaging } from './Migration20261124000004CreateMessaging';
import { Migration20261124000005EnforceLedgerInvariants } from './Migration20261124000005EnforceLedgerInvariants';
import { Migration20261125000006AllowReferencedWinLoss } from './Migration20261125000006AllowReferencedWinLoss';
import { Migration20261125000007ClaimOutboxMessages } from './Migration20261125000007ClaimOutboxMessages';
import { Migration20261126000008AlignReferenceRulesWithChallenge } from './Migration20261126000008AlignReferenceRulesWithChallenge';
import { Migration20261126000009EnforceLedgerTransactionIntegrity } from './Migration20261126000009EnforceLedgerTransactionIntegrity';

export const migrationsList = [
  Migration20261124000001CreateWallets,
  Migration20261124000002CreateWagerTransactions,
  Migration20261124000003CreateWalletLedgerEntries,
  Migration20261124000004CreateMessaging,
  Migration20261124000005EnforceLedgerInvariants,
  Migration20261125000006AllowReferencedWinLoss,
  Migration20261125000007ClaimOutboxMessages,
  Migration20261126000008AlignReferenceRulesWithChallenge,
  Migration20261126000009EnforceLedgerTransactionIntegrity,
];
