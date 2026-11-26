import { InvalidInputError, InvalidMessageStateError } from '../shared/errors';

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date;
}

/**
 * Registro de uma mensagem recebida, chaveado por `(consumerName, messageId)`.
 *
 * O inbox deduplica a MENSAGEM (redelivery do broker). A idempotency key da transação deduplica a
 * OPERAÇÃO DE NEGÓCIO. São duas camadas diferentes, e as duas existem de propósito.
 */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const [field, value] of [
      ['messageId', props.messageId],
      ['consumerName', props.consumerName],
      ['payloadHash', props.payloadHash],
    ] as const) {
      if (typeof value !== 'string' || value.length === 0) {
        throw new InvalidInputError(`Inbox exige ${field} não vazio`);
      }
    }
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt.getTime()),
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidMessageStateError(
        `Mensagem ${this.consumerName}/${this.messageId} já foi processada`,
      );
    }
    this._processedAt = new Date(at.getTime());
  }
}
