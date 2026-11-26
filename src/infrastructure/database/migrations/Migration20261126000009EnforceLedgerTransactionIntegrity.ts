import { Migration } from '@mikro-orm/migrations';

/** A ledger entry must belong to its transaction wallet and use its financial direction. */
export class Migration20261126000009EnforceLedgerTransactionIntegrity extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add constraint wager_transactions_wallet_id_id_unique unique (wallet_id, id);

      alter table wallet_ledger_entries
        drop constraint wallet_ledger_entries_transaction_id_fkey;
      alter table wallet_ledger_entries
        add constraint wallet_ledger_transaction_wallet_fk
        foreign key (wallet_id, transaction_id)
        references wager_transactions(wallet_id, id);

      create function assert_ledger_matches_transaction() returns trigger language plpgsql as $$
      declare
        target_transaction uuid;
        transaction_wallet uuid;
        transaction_kind varchar(16);
        reference_id uuid;
        reference_kind varchar(16);
        entry_wallet uuid;
        entry_direction varchar(6);
        expected_direction varchar(6);
      begin
        if tg_table_name = 'wallet_ledger_entries' then
          target_transaction := new.transaction_id;
        else
          target_transaction := new.id;
        end if;

        select wallet_id, kind, reference_transaction_id
          into transaction_wallet, transaction_kind, reference_id
          from wager_transactions where id = target_transaction;
        if not found then return null; end if;

        select wallet_id, direction
          into entry_wallet, entry_direction
          from wallet_ledger_entries
         where transaction_id = target_transaction
         limit 1;
        if not found then return null; end if;

        if entry_wallet <> transaction_wallet then
          raise exception 'ledger entry wallet differs from transaction wallet'
            using errcode = '23514', constraint = 'ledger_transaction_wallet_matches';
        end if;

        case transaction_kind
          when 'BET' then expected_direction := 'DEBIT';
          when 'OPENING' then expected_direction := 'CREDIT';
          when 'WIN' then expected_direction := 'CREDIT';
          when 'REFUND' then expected_direction := 'CREDIT';
          when 'ROLLBACK' then
            select kind into reference_kind from wager_transactions where id = reference_id;
            case reference_kind
              when 'BET' then expected_direction := 'CREDIT';
              when 'WIN' then expected_direction := 'DEBIT';
              when 'REFUND' then expected_direction := 'DEBIT';
              else expected_direction := null;
            end case;
          else expected_direction := null;
        end case;

        if expected_direction is null or entry_direction <> expected_direction then
          raise exception 'ledger direction does not match transaction kind'
            using errcode = '23514', constraint = 'ledger_transaction_direction_matches';
        end if;
        return null;
      end $$;

      create constraint trigger ledger_transaction_integrity_from_entry
        after insert on wallet_ledger_entries
        deferrable initially deferred for each row
        execute function assert_ledger_matches_transaction();
      create constraint trigger ledger_transaction_integrity_from_transaction
        after insert or update on wager_transactions
        deferrable initially deferred for each row
        execute function assert_ledger_matches_transaction();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger ledger_transaction_integrity_from_transaction on wager_transactions;
      drop trigger ledger_transaction_integrity_from_entry on wallet_ledger_entries;
      drop function assert_ledger_matches_transaction();

      alter table wallet_ledger_entries
        drop constraint wallet_ledger_transaction_wallet_fk;
      alter table wallet_ledger_entries
        add constraint wallet_ledger_entries_transaction_id_fkey
        foreign key (transaction_id) references wager_transactions(id);
      alter table wager_transactions
        drop constraint wager_transactions_wallet_id_id_unique;
    `);
  }
}
