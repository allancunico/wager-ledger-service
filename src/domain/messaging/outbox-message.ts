import { type BackoffOptions, computeBackoffMs } from '../shared/backoff';
import { deepFreeze } from '../shared/deep-freeze';
import { InvalidMessageStateError } from '../shared/errors';
import type { IntegrationEvent } from './integration-event';

/**
 * Backoff da publicação. Não há estado terminal de falha: um evento confirmado nunca é descartado,
 * então o publisher repete para sempre, com atraso crescente até o teto.
 */
export const DEFAULT_OUTBOX_BACKOFF: BackoffOptions = {
  baseSeconds: 1,
  maxSeconds: 300,
  jitterRatio: 0.2,
};

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  groupKey: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/**
 * Evento de integração pendente de publicação, gravado na MESMA transação SQL da alteração
 * financeira. Só é publicado depois do commit.
 *
 * `id` é o `eventId` do evento: estável entre republicações, é o que torna segura uma publicação
 * duplicada (dedup do broker como otimização, dedup do consumidor como garantia).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    /** Ordenação no broker (`MessageGroupId`): a wallet. */
    public readonly groupKey: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    // JSON.parse(JSON.stringify(...)) garante um payload só de JSON, desacoplado do evento.
    const payload = deepFreeze(
      JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>,
    );
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.groupKey(),
      event.eventType,
      payload,
      new Date(event.occurredAt.getTime()),
      0,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.groupKey,
      state.eventType,
      deepFreeze(state.payload),
      new Date(state.occurredAt.getTime()),
      state.attempts,
      state.nextAttemptAt ? new Date(state.nextAttemptAt.getTime()) : undefined,
      state.publishedAt ? new Date(state.publishedAt.getTime()) : undefined,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt ? new Date(this._nextAttemptAt.getTime()) : undefined;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt ? new Date(this._publishedAt.getTime()) : undefined;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e com a próxima tentativa vencida (sem `nextAttemptAt`, vence imediatamente). */
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Evento ${this.id} já foi marcado como publicado`);
    }
    this._publishedAt = new Date(at.getTime());
    this._nextAttemptAt = undefined;
  }

  /** Incrementa `attempts` e agenda a próxima tentativa com backoff exponencial e jitter. */
  scheduleRetry(
    now: Date,
    options: BackoffOptions = DEFAULT_OUTBOX_BACKOFF,
    random: () => number = Math.random,
  ): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Evento ${this.id} já publicado: não há o que repetir`);
    }
    const delayMs = computeBackoffMs(this._attempts, options, random);
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + delayMs);
  }
}
