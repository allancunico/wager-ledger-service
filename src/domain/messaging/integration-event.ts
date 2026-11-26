import { deepFreeze } from '../shared/deep-freeze';

export interface IntegrationEventProps<T> {
  /** Estável entre republicações: é o id da linha da outbox, e a chave de dedup no consumidor. */
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto comum a todas as factories `from`. */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601 */
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Envelope de evento de integração. `eventType` e `version` ficam no TIPO (cada subclasse os
 * declara), não em uma string solta no ponto de uso.
 *
 * `data` carrega só JSON (valores monetários como `MoneyProps`, nunca `Money`): o payload da
 * outbox precisa ser estável e versionável.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  private readonly _occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this._occurredAt = new Date(props.occurredAt.getTime());
    this.data = deepFreeze(props.data);
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt.getTime());
  }

  /**
   * Chave de ordenação no broker (`MessageGroupId` da fila FIFO): a wallet. Eventos de uma wallet
   * saem em ordem; wallets diferentes seguem em paralelo.
   */
  abstract groupKey(): string;

  /** Envelope serializado, gravado como payload da outbox. */
  toJSON(): IntegrationEventEnvelope<T> {
    const envelope: IntegrationEventEnvelope<T> = {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
    if (this.causationId !== undefined) {
      envelope.causationId = this.causationId;
    }
    return envelope;
  }
}
