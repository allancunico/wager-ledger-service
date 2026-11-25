import { Migration } from '@mikro-orm/migrations';

export class Migration20261124000002CreateWagerTransactions extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(255) not null,
        external_transaction_id varchar(255) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets(id),
        player_id uuid not null,
        round_id varchar(255) not null,
        game_id varchar(255) not null,
        kind varchar(16) not null,
        amount numeric(19,2) not null,
        currency char(3) not null,
        reference_external_transaction_id varchar(255),
        reference_transaction_id uuid references wager_transactions(id),
        status varchar(24) not null,
        failure_code varchar(64),
        created_at timestamptz not null,
        resolved_at timestamptz,
        balance_snapshot numeric(19,2),
        balance_snapshot_currency char(3),
        reference_attempts integer not null default 0,
        next_reference_attempt_at timestamptz,
        constraint wager_transactions_provider_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_transactions_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_transactions_amount_positive check (amount > 0),
        constraint wager_transactions_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wager_transactions_kind_valid check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        constraint wager_transactions_status_valid check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        constraint wager_transactions_kind_reference check (
          (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
          or (kind not in ('REFUND','ROLLBACK') and reference_external_transaction_id is null)
        ),
        constraint wager_transactions_reference_id_consistency check (
          (status = 'PROCESSED' and kind in ('REFUND','ROLLBACK') and reference_transaction_id is not null)
          or (status <> 'PROCESSED' or kind not in ('REFUND','ROLLBACK'))
        ),
        constraint wager_transactions_snapshot_currency check (
          (balance_snapshot is null and balance_snapshot_currency is null)
          or (balance_snapshot is not null and balance_snapshot >= 0 and balance_snapshot_currency = currency)
        ),
        constraint wager_transactions_reference_attempts_nonnegative check (reference_attempts >= 0)
      );
      create index wager_transactions_wallet_created_idx on wager_transactions(wallet_id, created_at, id);
      create index wager_transactions_pending_reference_idx on wager_transactions(next_reference_attempt_at, created_at) where status = 'PENDING_REFERENCE';
      create unique index wager_transactions_one_processed_reversal_idx on wager_transactions(reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');
      create trigger wager_transactions_no_truncate before truncate on wager_transactions for each statement execute function forbid_truncate();

      create function prevent_terminal_transaction_update() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'terminal transaction is immutable' using errcode = '23514', constraint = 'wager_transactions_terminal_immutable';
        end if;
        return new;
      end $$;
      create trigger wager_transactions_terminal_guard before update on wager_transactions for each row execute function prevent_terminal_transaction_update();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop table wager_transactions; drop function prevent_terminal_transaction_update();',
    );
  }
}
