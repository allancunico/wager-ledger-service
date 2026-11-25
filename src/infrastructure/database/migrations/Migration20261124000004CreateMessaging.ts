import { Migration } from '@mikro-orm/migrations';

export class Migration20261124000004CreateMessaging extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages (
        consumer_name varchar(100) not null,
        message_id varchar(255) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );
      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        group_key uuid not null,
        event_type varchar(100) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0,
        next_attempt_at timestamptz,
        published_at timestamptz,
        constraint outbox_attempts_nonnegative check (attempts >= 0),
        constraint outbox_payload_event_id check (payload->>'eventId' = id::text)
      );
      create index outbox_pending_idx on outbox_messages(next_attempt_at, occurred_at) where published_at is null;
      create trigger inbox_no_truncate before truncate on inbox_messages for each statement execute function forbid_truncate();
      create trigger outbox_no_truncate before truncate on outbox_messages for each statement execute function forbid_truncate();
      create function prevent_outbox_delete() returns trigger language plpgsql as $$
      begin
        if old.published_at is null then
          raise exception 'pending outbox event cannot be deleted' using errcode = '23514', constraint = 'outbox_pending_immutable';
        end if;
        return old;
      end $$;
      create trigger outbox_delete_guard before delete on outbox_messages for each row execute function prevent_outbox_delete();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(
      'drop table outbox_messages; drop table inbox_messages; drop function prevent_outbox_delete();',
    );
  }
}
