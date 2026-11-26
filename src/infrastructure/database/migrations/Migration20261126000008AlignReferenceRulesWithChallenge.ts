import { Migration } from '@mikro-orm/migrations';

/** One processed reversal per reference and reversal kind; LOSS cannot carry a reference. */
export class Migration20261126000008AlignReferenceRulesWithChallenge extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      do $$ begin
        if exists (
          select 1 from wager_transactions
          where kind = 'LOSS' and reference_external_transaction_id is not null
        ) then
          raise exception 'Cannot align LOSS references: existing LOSS transactions have references';
        end if;
      end $$;

      drop index wager_transactions_one_processed_reversal_idx;
      create unique index wager_transactions_one_processed_reversal_per_kind_idx
        on wager_transactions(reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');

      alter table wager_transactions drop constraint wager_transactions_kind_reference;
      alter table wager_transactions add constraint wager_transactions_kind_reference check (
        (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
        or kind = 'WIN'
        or (kind in ('OPENING','BET','LOSS') and reference_external_transaction_id is null)
      );
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      do $$ begin
        if exists (
          select reference_transaction_id
          from wager_transactions
          where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK')
          group by reference_transaction_id
          having count(*) > 1
        ) then
          raise exception 'Cannot restore one-reversal limit: a reference has both REFUND and ROLLBACK processed';
        end if;
      end $$;

      drop index wager_transactions_one_processed_reversal_per_kind_idx;
      create unique index wager_transactions_one_processed_reversal_idx
        on wager_transactions(reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');

      alter table wager_transactions drop constraint wager_transactions_kind_reference;
      alter table wager_transactions add constraint wager_transactions_kind_reference check (
        (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
        or kind in ('WIN','LOSS')
        or (kind in ('OPENING','BET') and reference_external_transaction_id is null)
      );
    `);
  }
}
