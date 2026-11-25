import { Migration } from '@mikro-orm/migrations';

export class Migration20261124000001CreateWallets extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function forbid_truncate() returns trigger language plpgsql as $$
      begin raise exception 'TRUNCATE is forbidden on %', TG_TABLE_NAME using errcode = '23514'; end $$;

      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency char(3) not null,
        balance numeric(19,2) not null default 0,
        version integer not null default 1,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_balance_nonnegative check (balance >= 0),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_version_positive check (version >= 1)
      );
      create trigger wallets_no_truncate before truncate on wallets for each statement execute function forbid_truncate();

      create function enforce_wallet_version() returns trigger language plpgsql as $$
      begin
        if new.balance is distinct from old.balance then
          if new.version <> old.version + 1 then
            raise exception 'wallet version must increment with balance' using errcode = '23514', constraint = 'wallets_version_tracks_balance';
          end if;
        elsif new.version <> old.version then
          raise exception 'wallet version may change only with balance' using errcode = '23514', constraint = 'wallets_version_tracks_balance';
        end if;
        return new;
      end $$;
      create trigger wallets_version_guard before update on wallets for each row execute function enforce_wallet_version();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop table wallets; drop function enforce_wallet_version(); drop function forbid_truncate();',
    );
  }
}
