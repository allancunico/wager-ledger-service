import { Migration } from '@mikro-orm/migrations';

export class Migration20261124000005EnforceLedgerInvariants extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function assert_wallet_matches_ledger() returns trigger language plpgsql as $$
      declare target_wallet uuid; wallet_balance numeric(19,2); ledger_balance numeric(19,2);
      begin
        target_wallet := coalesce(new.id, old.id);
        select balance into wallet_balance from wallets where id = target_wallet;
        if not found then return null; end if;
        select balance_after into ledger_balance from wallet_ledger_entries where wallet_id = target_wallet order by seq desc limit 1;
        if ledger_balance is null then ledger_balance := 0; end if;
        if wallet_balance <> ledger_balance then
          raise exception 'wallet balance does not match ledger' using errcode = '23514', constraint = 'wallet_balance_matches_ledger';
        end if;
        return null;
      end $$;
      create constraint trigger wallet_balance_ledger_deferred after insert or update on wallets
        deferrable initially deferred for each row execute function assert_wallet_matches_ledger();
      create constraint trigger ledger_wallet_balance_deferred after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function assert_wallet_matches_ledger();

      create function assert_transaction_matches_ledger() returns trigger language plpgsql as $$
      declare target_id uuid; tx_kind varchar(16); tx_status varchar(24); tx_amount numeric(19,2); tx_currency char(3); entry_count integer; entry_amount numeric(19,2); entry_currency char(3);
      begin
        target_id := coalesce(new.id, old.id);
        select kind, status, amount, currency into tx_kind, tx_status, tx_amount, tx_currency from wager_transactions where id = target_id;
        if not found then return null; end if;
        select count(*), max(amount), max(currency) into entry_count, entry_amount, entry_currency from wallet_ledger_entries where transaction_id = target_id;
        if tx_status = 'PROCESSED' and tx_kind <> 'LOSS' then
          if entry_count <> 1 or entry_amount <> tx_amount or entry_currency <> tx_currency then
            raise exception 'processed balance transaction must have exactly one matching ledger entry' using errcode = '23514', constraint = 'transaction_matches_ledger';
          end if;
        elsif entry_count <> 0 then
          raise exception 'non-applied transaction cannot have ledger entry' using errcode = '23514', constraint = 'transaction_matches_ledger';
        end if;
        return null;
      end $$;
      create constraint trigger transaction_ledger_deferred after insert or update on wager_transactions
        deferrable initially deferred for each row execute function assert_transaction_matches_ledger();
      create constraint trigger ledger_transaction_deferred after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function assert_transaction_matches_ledger();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger ledger_transaction_deferred on wallet_ledger_entries;
      drop trigger transaction_ledger_deferred on wager_transactions;
      drop trigger ledger_wallet_balance_deferred on wallet_ledger_entries;
      drop trigger wallet_balance_ledger_deferred on wallets;
      drop function assert_transaction_matches_ledger(); drop function assert_wallet_matches_ledger();`);
  }
}
