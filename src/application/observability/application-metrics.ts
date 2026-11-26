import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from 'prom-client';

export class ApplicationMetrics {
  readonly registry = new Registry();
  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Transações decididas pelo caso de uso financeiro.',
    labelNames: ['status', 'channel'] as const,
    registers: [this.registry],
  });
  private readonly replays = new Counter({
    name: 'wager_idempotent_replays_total',
    help: 'Replays idempotentes e mensagens SQS deduplicadas.',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wager_retries_total',
    help: 'Tentativas operacionais repetidas por workers e SQS.',
    labelNames: ['component'] as const,
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'wager_messages_dead_lettered_total',
    help: 'Mensagens que atingiram o limite configurado de entregas SQS.',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'wager_database_lock_conflicts_total',
    help: 'Timeouts de lock e deadlocks PostgreSQL.',
    labelNames: ['sqlstate'] as const,
    registers: [this.registry],
  });
  private readonly transactionDuration = new Histogram({
    name: 'wager_transaction_processing_duration_seconds',
    help: 'Duração do processamento transacional financeiro.',
    labelNames: ['channel'] as const,
    registers: [this.registry],
  });
  private readonly reconciliationMismatches = new Counter({
    name: 'wager_reconciliation_mismatches_total',
    help: 'Divergências detectadas entre saldo da wallet e ledger.',
    registers: [this.registry],
  });
  private readonly outboxPending = new Gauge({
    name: 'wager_outbox_pending_messages',
    help: 'Quantidade atual de eventos ainda não publicados na outbox.',
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'wager_outbox_oldest_pending_age_seconds',
    help: 'Idade do evento pendente mais antigo da outbox.',
    registers: [this.registry],
  });
  private readonly deadLetterMessages = new Gauge({
    name: 'wager_dead_letter_queue_visible_messages',
    help: 'Mensagens visíveis atualmente na DLQ de entrada.',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  recordTransaction(status: string, channel: 'http' | 'sqs'): void {
    this.transactions.inc({ status, channel });
  }

  recordReplay(channel: 'http' | 'sqs'): void {
    this.replays.inc({ channel });
  }

  recordRetry(component: 'sqs' | 'outbox' | 'pending_reference'): void {
    this.retries.inc({ component });
  }

  recordDeadLetter(): void {
    this.deadLetters.inc();
  }

  recordLockConflict(sqlstate: string): void {
    this.lockConflicts.inc({ sqlstate });
  }

  observeTransactionDuration(channel: 'http' | 'sqs', seconds: number): void {
    this.transactionDuration.observe({ channel }, seconds);
  }

  recordReconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }

  setOutboxState(pending: number, oldestAgeSeconds: number): void {
    this.outboxPending.set(pending);
    this.outboxLag.set(oldestAgeSeconds);
  }

  setDeadLetterMessages(count: number): void {
    this.deadLetterMessages.set(count);
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }
}
