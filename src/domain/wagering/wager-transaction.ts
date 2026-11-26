import {
  CurrencyMismatchError,
  InvalidInputError,
  InvalidMoneyError,
  InvalidTransactionStateError,
  MissingReferenceError,
  OpeningNotAllowedError,
} from '../shared/errors';
import type { Money } from '../shared/money';
import { LedgerDirection, oppositeDirection } from '../wallet/wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca vem da API nem da fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não decidida. Só existe dentro da transação SQL que a decide. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada chegar ou ser processada. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal, auditável). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/** Códigos estáveis e legíveis por máquina. Taxonomia completa em ARCHITECTURE.md (seção 3.6). */
export enum FailureCode {
  /** `BET` com saldo menor que o valor. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /** Reversão que debitaria além do saldo (ex.: `ROLLBACK` de `WIN`). Distinto de saldo insuficiente em aposta. */
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  /** TTL esgotado e a referência nunca chegou. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** A referência existe, mas está `REJECTED`/`FAILED` (ou ainda pendente ao fim do TTL). */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Já existe uma reversão processada da referência com este mesmo tipo. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Referência de outro provider, player, wallet ou rodada. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  AmountMismatch = 'AMOUNT_MISMATCH',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Só o consumidor SQS grava: a mensagem esgotou as tentativas e foi para a DLQ. */
  ProcessingAttemptsExhausted = 'PROCESSING_ATTEMPTS_EXHAUSTED',
}

/** Tipos de transação que cada tipo de operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export function allowedReferenceKinds(kind: WagerTransactionKind): readonly WagerTransactionKind[] {
  return ALLOWED_REFERENCE_KINDS[kind] ?? [];
}

export function isReversalKind(kind: WagerTransactionKind): boolean {
  return kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;
}

const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

/** Limite dos identificadores do provedor (colunas varchar(255) no schema). */
export const MAX_IDENTIFIER_LENGTH = 255;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  /** Id da referência no provedor (não o id interno). */
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface CreateOpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  payloadHash: string;
  createdAt: Date;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  /** Momento da decisão terminal (processada, rejeitada ou falha). */
  resolvedAt?: Date;
  /** Saldo da wallet observado quando a transação foi decidida: base do replay idempotente. */
  balanceSnapshot?: Money;
  /** Reavaliações já feitas enquanto em `PENDING_REFERENCE`. */
  referenceAttempts: number;
  nextReferenceAttemptAt?: Date;
}

/** Provedor e identificadores do `OPENING`, que não vem de nenhum provedor externo. */
export const SYSTEM_PROVIDER_ID = 'system';

function assertIdentifier(field: string, value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidInputError(`${field} é obrigatório e não pode ser vazio`);
  }
  if (value.length > MAX_IDENTIFIER_LENGTH) {
    throw new InvalidInputError(`${field} excede ${MAX_IDENTIFIER_LENGTH} caracteres`);
  }
}

/**
 * Transação de aposta recebida de um provedor.
 *
 * Máquina de estados (terminais: PROCESSED, REJECTED, FAILED):
 *
 *   PENDING ──► PROCESSED
 *   PENDING ──► REJECTED
 *   PENDING ──► FAILED
 *   PENDING ──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *
 * Tentar transicionar a partir de um estado terminal é erro de programação
 * (`InvalidTransactionStateError`), não caminho de negócio.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _resolvedAt: Date | undefined,
    private _balanceSnapshot: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  /** Nasce em `PENDING`. Valida o contrato de entrada e a exigência de referência por tipo. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new OpeningNotAllowedError('OPENING é interno e não pode ser submetido');
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidInputError(`kind inválido: ${JSON.stringify(props.kind)}`);
    }
    assertIdentifier('id', props.id);
    assertIdentifier('providerId', props.providerId);
    assertIdentifier('externalTransactionId', props.externalTransactionId);
    assertIdentifier('idempotencyKey', props.idempotencyKey);
    assertIdentifier('payloadHash', props.payloadHash);
    assertIdentifier('walletId', props.walletId);
    assertIdentifier('playerId', props.playerId);
    assertIdentifier('roundId', props.roundId);
    assertIdentifier('gameId', props.gameId);

    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('O valor de uma transação deve ser maior que zero');
    }

    const reference = props.referenceExternalTransactionId;
    if (isReversalKind(props.kind) && reference === undefined) {
      throw new MissingReferenceError(`${props.kind} exige referenceExternalTransactionId`);
    }
    if (reference !== undefined) {
      if (allowedReferenceKinds(props.kind).length === 0) {
        throw new InvalidInputError(`${props.kind} não aceita referência`);
      }
      assertIdentifier('referenceExternalTransactionId', reference);
      if (reference === props.externalTransactionId) {
        throw new InvalidInputError('Uma transação não pode referenciar a si mesma');
      }
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      reference,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  /**
   * Transação interna `OPENING`, criada junto com a wallet. Já nasce `PROCESSED`: o lançamento de
   * abertura e a transação são gravados na mesma transação SQL da criação da wallet.
   */
  static opening(props: CreateOpeningTransactionProps): WagerTransaction {
    assertIdentifier('id', props.id);
    assertIdentifier('walletId', props.walletId);
    assertIdentifier('playerId', props.playerId);
    assertIdentifier('payloadHash', props.payloadHash);
    if (!props.money.isPositive()) {
      throw new InvalidMoneyError('O crédito de abertura deve ser maior que zero');
    }
    const key = `opening:${props.walletId}`;
    return new WagerTransaction(
      props.id,
      SYSTEM_PROVIDER_ID,
      key,
      key,
      props.payloadHash,
      props.walletId,
      props.playerId,
      'opening',
      'opening',
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      new Date(props.createdAt.getTime()),
      WagerTransactionStatus.Processed,
      undefined,
      undefined,
      new Date(props.createdAt.getTime()),
      props.money,
      0,
      undefined,
    );
  }

  /** Reconstrução a partir da persistência. Não revalida regras nem transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt.getTime()),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resolvedAt ? new Date(state.resolvedAt.getTime()) : undefined,
      state.balanceSnapshot,
      state.referenceAttempts,
      state.nextReferenceAttemptAt ? new Date(state.nextReferenceAttemptAt.getTime()) : undefined,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get createdAt(): Date {
    return new Date(this._createdAt.getTime());
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get resolvedAt(): Date | undefined {
    return this._resolvedAt ? new Date(this._resolvedAt.getTime()) : undefined;
  }

  /** Saldo da wallet no momento da decisão. Presente em `PROCESSED` e `REJECTED` de negócio. */
  get balanceSnapshot(): Money | undefined {
    return this._balanceSnapshot;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt
      ? new Date(this._nextReferenceAttemptAt.getTime())
      : undefined;
  }

  // ---- transições

  /** `PENDING` ou `PENDING_REFERENCE` → `PROCESSED`. `balance` é o saldo observado após a aplicação. */
  markProcessed(referenceTransactionId: string | undefined, at: Date, balance: Money): void {
    this.assertNotTerminal('markProcessed');
    this.assertSnapshotCurrency(balance);
    if (isReversalKind(this.kind) && referenceTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        `${this.kind} não pode ser processada sem o id interno da referência`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resolvedAt = new Date(at.getTime());
    this._balanceSnapshot = balance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** `PENDING` → `PENDING_REFERENCE`. Só faz sentido para quem tem referência a esperar. */
  markPendingReference(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(
        `markPendingReference exige PENDING, estado atual: ${this._status}`,
      );
    }
    if (this.referenceExternalTransactionId === undefined) {
      throw new InvalidTransactionStateError(
        `${this.kind} sem referência não pode ficar em PENDING_REFERENCE`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceAttemptAt = new Date(nextAttemptAt.getTime());
  }

  /** Registra uma reavaliação que continuou sem referência. Só em `PENDING_REFERENCE`. */
  recordReferenceRetry(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `recordReferenceRetry exige PENDING_REFERENCE, estado atual: ${this._status}`,
      );
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = new Date(nextAttemptAt.getTime());
  }

  /** `PENDING` ou `PENDING_REFERENCE` → `REJECTED`. `balance` é o saldo observado, quando há wallet. */
  reject(code: FailureCode, at: Date, balance?: Money): void {
    this.assertNotTerminal('reject');
    if (balance) this.assertSnapshotCurrency(balance);
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resolvedAt = new Date(at.getTime());
    this._balanceSnapshot = balance;
    this._nextReferenceAttemptAt = undefined;
  }

  /** `PENDING` ou `PENDING_REFERENCE` → `FAILED` (erro permanente de infraestrutura). */
  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._resolvedAt = new Date(at.getTime());
    this._nextReferenceAttemptAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.includes(this._status);
  }

  /** `LOSS` registra o resultado sem mover saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return isReversalKind(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /** Pendente e com a próxima tentativa já vencida (para o worker). */
  isDueForReferenceRetry(now: Date): boolean {
    return (
      this._status === WagerTransactionStatus.PendingReference &&
      this._nextReferenceAttemptAt !== undefined &&
      this._nextReferenceAttemptAt.getTime() <= now.getTime()
    );
  }

  /**
   * Direção do lançamento. `ROLLBACK` é o inverso da direção da referência, então a referência é
   * obrigatória para ele. `LOSS` não gera lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(
          'LOSS não afeta o saldo e não tem direção de lançamento',
        );
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError('ROLLBACK exige a transação de referência');
        }
        if (!allowedReferenceKinds(this.kind).includes(reference.kind)) {
          throw new InvalidTransactionStateError(`ROLLBACK não pode reverter ${reference.kind}`);
        }
        return oppositeDirection(reference.ledgerDirectionFor());
      }
    }
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `${operation} não é permitido: a transação já está em estado terminal (${this._status})`,
      );
    }
  }

  private assertSnapshotCurrency(balance: Money): void {
    if (balance.currency !== this.money.currency) {
      throw new CurrencyMismatchError(
        `Saldo observado em ${balance.currency} para uma transação em ${this.money.currency}`,
      );
    }
  }
}
