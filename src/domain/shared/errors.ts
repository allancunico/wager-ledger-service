/**
 * Erros de domínio. Cada classe carrega um `code` estável e legível por máquina.
 *
 * Duas famílias:
 *  - erros de ENTRADA INVÁLIDA (payload malformado): a camada de borda os traduz em 400;
 *  - erros de PROGRAMAÇÃO / INVARIANTE (transição ilegal, lançamento desbalanceado): nunca são
 *    caminho de negócio. Se chegarem à borda, são bugs (500).
 *
 * Rejeições de negócio (saldo insuficiente, referência inválida etc.) NÃO são exceções: o avaliador
 * de regras devolve uma decisão com um `FailureCode`.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Valor monetário malformado (formato, escala, sinal, magnitude). */
export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
}

/** Moeda inválida ou operação entre moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
}

/**
 * Débito acima do saldo. A `Wallet` lança isto para proteger a invariante "saldo nunca negativo".
 * O avaliador de regras verifica antes e decide o `FailureCode`; esta exceção é a última barreira.
 */
export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
}

/** Dados de entrada inválidos que não são de dinheiro (campo vazio, referência indevida etc.). */
export class InvalidInputError extends DomainError {
  readonly code = 'INVALID_INPUT';
}

/** `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`. */
export class MissingReferenceError extends DomainError {
  readonly code = 'MISSING_REFERENCE';
}

/** `OPENING` é interno: não pode ser submetido pela API nem pela fila. */
export class OpeningNotAllowedError extends DomainError {
  readonly code = 'OPENING_NOT_ALLOWED';
}

/** Transição de estado ilegal (ex.: tentar mudar uma transação já terminal). Erro de programação. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
}

/** Lançamento de ledger cuja aritmética não fecha. Erro de programação. */
export class LedgerImbalanceError extends DomainError {
  readonly code = 'LEDGER_IMBALANCE';
}

/** Mensagem de inbox ou evento de outbox em estado incompatível com a operação. */
export class InvalidMessageStateError extends DomainError {
  readonly code = 'INVALID_MESSAGE_STATE';
}
