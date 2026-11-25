import { Migration } from '@mikro-orm/migrations';

/** WIN supports an optional BET reference; LOSS references remain a provisional domain extension. */
export class Migration20261125000006AllowReferencedWinLoss extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions drop constraint wager_transactions_kind_reference;
      alter table wager_transactions add constraint wager_transactions_kind_reference check (
        (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
        or kind in ('WIN','LOSS')
        or (kind in ('OPENING','BET') and reference_external_transaction_id is null)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wager_transactions drop constraint wager_transactions_kind_reference;
      alter table wager_transactions add constraint wager_transactions_kind_reference check (
        (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
        or (kind not in ('REFUND','ROLLBACK') and reference_external_transaction_id is null)
      );
    `);
  }
}
