import { Migration } from '@mikro-orm/migrations';

export class Migration20261124000003CreateWalletLedgerEntries extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallet_ledger_entries (
        seq bigint generated always as identity unique,
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction varchar(6) not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        balance_before numeric(19,2) not null,
        balance_after numeric(19,2) not null,
        created_at timestamptz not null,
        constraint wallet_ledger_wallet_transaction_unique unique (wallet_id, transaction_id),
        constraint wallet_ledger_direction_valid check (direction in ('DEBIT','CREDIT')),
        constraint wallet_ledger_amount_positive check (amount > 0),
        constraint wallet_ledger_balances_nonnegative check (balance_before >= 0 and balance_after >= 0),
        constraint wallet_ledger_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallet_ledger_arithmetic check (
          (direction = 'CREDIT' and balance_after = balance_before + amount)
          or (direction = 'DEBIT' and balance_after = balance_before - amount)
        )
      );
      create index wallet_ledger_wallet_seq_idx on wallet_ledger_entries(wallet_id, seq desc);
      create trigger wallet_ledger_no_truncate before truncate on wallet_ledger_entries for each statement execute function forbid_truncate();

      create function forbid_ledger_mutation() returns trigger language plpgsql as $$
      begin raise exception 'wallet ledger is immutable' using errcode = '23514', constraint = 'wallet_ledger_immutable'; end $$;
      create trigger wallet_ledger_immutable before update or delete on wallet_ledger_entries for each row execute function forbid_ledger_mutation();

      create function enforce_ledger_chain() returns trigger language plpgsql as $$
      declare current_balance numeric(19,2);
      begin
        perform 1 from wallets where id = new.wallet_id for update;
        select balance_after into current_balance from wallet_ledger_entries where wallet_id = new.wallet_id order by seq desc limit 1;
        if current_balance is null then current_balance := 0; end if;
        if new.balance_before <> current_balance then
          raise exception 'ledger entry does not continue wallet chain' using errcode = '23514', constraint = 'wallet_ledger_chain_contiguous';
        end if;
        return new;
      end $$;
      create trigger wallet_ledger_chain_guard before insert on wallet_ledger_entries for each row execute function enforce_ledger_chain();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop table wallet_ledger_entries; drop function enforce_ledger_chain(); drop function forbid_ledger_mutation();',
    );
  }
}
