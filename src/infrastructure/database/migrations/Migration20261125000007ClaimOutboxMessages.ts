import { Migration } from '@mikro-orm/migrations';

/** Adds durable leases for publishers and an insertion order for FIFO events per wallet. */
export class Migration20261125000007ClaimOutboxMessages extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table outbox_messages add column seq bigint generated always as identity;
      create unique index outbox_messages_seq_unique on outbox_messages(seq);
      alter table outbox_messages add column claim_token uuid;
      alter table outbox_messages add column claimed_until timestamptz;
      create index outbox_unpublished_group_seq_idx on outbox_messages(group_key, seq)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop index outbox_unpublished_group_seq_idx;
      drop index outbox_messages_seq_unique;
      alter table outbox_messages drop column claimed_until;
      alter table outbox_messages drop column claim_token;
      alter table outbox_messages drop column seq;
    `);
  }
}
