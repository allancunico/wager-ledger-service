import { InvalidTransactionStateError } from '../shared/errors';
import type { Wallet } from '../wallet/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '../wallet/wallet-ledger-entry';
import type { PendingReferencePolicy } from './pending-reference-policy';
import {
  allowedReferenceKinds,
  FailureCode,
  isReversalKind,
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';

/** Por que a transação precisa esperar. */
export type PendingReason = 'REFERENCE_MISSING' | 'REFERENCE_PENDING';

/** Decisão do avaliador de regras. Não altera nada: só diz o que fazer. */
export type Decision =
  | {
      type: 'APPLY';
      /** `null` quando a transação não move saldo (`LOSS`). */
      direction: LedgerDirection | null;
    }
  | { type: 'PENDING_REFERENCE'; reason: PendingReason }
  | { type: 'REJECT'; code: FailureCode };

export interface EvaluationInput {
  transaction: WagerTransaction;
  /** A wallet já carregada SOB LOCK. */
  wallet: Wallet;
  /**
   * A transação referenciada, resolvida por `(providerId, referenceExternalTransactionId)`.
   * `undefined` quando não existe (ainda) ou quando a transação não tem referência.
   */
  reference?: WagerTransaction;
  /** Já existe reversão `PROCESSED` desta referência (`REFUND` ou `ROLLBACK`). */
  referenceAlreadyReversed: boolean;
}

/**
 * Avalia as regras de negócio (README seção 7) sem efeito colateral.
 *
 * Ordem de verificação, da mais estrutural à mais dependente de estado. A ordem importa: ela
 * decide QUAL `failureCode` o provedor recebe quando mais de uma regra é violada, e deve ser
 * estável.
 *
 *  1. wallet pertence ao player da transação;
 *  2. moeda da transação igual à da wallet;
 *  3. se há referência:
 *       a. ausente                         → espera (REFERENCE_MISSING)
 *       b. tipo de referência não permitido
 *       c. outro provider/player/wallet/rodada
 *       d. moeda da referência diferente
 *       e. referência pendente             → espera (REFERENCE_PENDING)
 *          referência rejeitada/falha      → REFERENCE_NOT_PROCESSED
 *       f. (reversões) valor diferente; já revertida
 *  4. efeito no saldo: BET sem saldo, ou reversão que debitaria além do saldo.
 *
 * As verificações (b) a (d) usam só campos imutáveis, então valem mesmo com a referência ainda
 * pendente: uma referência incompatível é rejeitada na hora, sem esperar.
 */
export function evaluate(input: EvaluationInput): Decision {
  const { transaction: tx, wallet, reference } = input;

  if (wallet.playerId !== tx.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (tx.money.currency !== wallet.currency) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.referenceExternalTransactionId !== undefined) {
    if (!reference) {
      return { type: 'PENDING_REFERENCE', reason: 'REFERENCE_MISSING' };
    }
    if (!allowedReferenceKinds(tx.kind).includes(reference.kind)) {
      return reject(FailureCode.ReferenceKindNotAllowed);
    }
    if (
      reference.providerId !== tx.providerId ||
      reference.playerId !== tx.playerId ||
      reference.walletId !== tx.walletId ||
      reference.roundId !== tx.roundId
    ) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (reference.money.currency !== tx.money.currency) {
      return reject(FailureCode.CurrencyMismatch);
    }
    if (
      reference.status === WagerTransactionStatus.Pending ||
      reference.status === WagerTransactionStatus.PendingReference
    ) {
      return { type: 'PENDING_REFERENCE', reason: 'REFERENCE_PENDING' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (isReversalKind(tx.kind)) {
      if (!reference.money.equals(tx.money)) {
        return reject(FailureCode.AmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return reject(FailureCode.ReferenceAlreadyReversed);
      }
    }
  }

  switch (tx.kind) {
    case WagerTransactionKind.Bet:
      return wallet.canDebit(tx.money)
        ? { type: 'APPLY', direction: LedgerDirection.Debit }
        : reject(FailureCode.InsufficientFunds);
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      return { type: 'APPLY', direction: LedgerDirection.Credit };
    case WagerTransactionKind.Loss:
      return { type: 'APPLY', direction: null };
    case WagerTransactionKind.Rollback: {
      const direction = tx.ledgerDirectionFor(reference);
      if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
        return reject(FailureCode.ReversalWouldOverdraw);
      }
      return { type: 'APPLY', direction };
    }
    case WagerTransactionKind.Opening:
      throw new InvalidTransactionStateError('OPENING não passa pelo avaliador de regras');
  }
}

function reject(code: FailureCode): Decision {
  return { type: 'REJECT', code };
}

export interface ProcessInput extends EvaluationInput {
  now: Date;
  /** Gera o id do lançamento, só chamado quando há lançamento. */
  newEntryId: () => string;
  pendingReferencePolicy: PendingReferencePolicy;
  random?: () => number;
}

export type ProcessOutcome =
  | {
      type: 'PROCESSED';
      /** `null` para `LOSS`. */
      entry: WalletLedgerEntry | null;
    }
  | { type: 'REJECTED'; failureCode: FailureCode }
  | {
      type: 'PENDING_REFERENCE';
      /** `true` na primeira vez (emite o evento uma vez só); `false` nas reavaliações do worker. */
      enteredNow: boolean;
    };

/**
 * Avalia e APLICA o resultado na transação e na wallet, que são mutadas. O chamador persiste o
 * agregado e o lançamento na mesma transação SQL, sob o lock da wallet.
 *
 * Reavaliação de `PENDING_REFERENCE`: se a referência continua ausente ou pendente e o TTL
 * esgotou, a transação é rejeitada (`REFERENCE_NOT_FOUND` ou `REFERENCE_NOT_PROCESSED`).
 */
export function processTransaction(input: ProcessInput): ProcessOutcome {
  const { transaction: tx, wallet, now } = input;
  if (tx.isTerminal()) {
    throw new InvalidTransactionStateError(
      `Transação ${tx.id} já está em estado terminal (${tx.status})`,
    );
  }
  if (tx.walletId !== wallet.id) {
    throw new InvalidTransactionStateError(
      `Transação ${tx.id} pertence à wallet ${tx.walletId}, não à ${wallet.id}`,
    );
  }

  const decision = evaluate(input);

  switch (decision.type) {
    case 'APPLY': {
      let entry: WalletLedgerEntry | null = null;
      if (decision.direction !== null) {
        const movement = {
          entryId: input.newEntryId(),
          transactionId: tx.id,
          money: tx.money,
          at: now,
        };
        entry =
          decision.direction === LedgerDirection.Debit
            ? wallet.debit(movement)
            : wallet.credit(movement);
      }
      tx.markProcessed(input.reference?.id, now, wallet.balance);
      return { type: 'PROCESSED', entry };
    }

    case 'REJECT': {
      tx.reject(decision.code, now, wallet.balance);
      return { type: 'REJECTED', failureCode: decision.code };
    }

    case 'PENDING_REFERENCE': {
      const random = input.random ?? Math.random;
      if (tx.status === WagerTransactionStatus.Pending) {
        tx.markPendingReference(input.pendingReferencePolicy.nextAttemptAt(0, now, random));
        return { type: 'PENDING_REFERENCE', enteredNow: true };
      }
      if (input.pendingReferencePolicy.isExpired(tx.createdAt, now)) {
        const code =
          decision.reason === 'REFERENCE_MISSING'
            ? FailureCode.ReferenceNotFound
            : FailureCode.ReferenceNotProcessed;
        tx.reject(code, now, wallet.balance);
        return { type: 'REJECTED', failureCode: code };
      }
      tx.recordReferenceRetry(
        input.pendingReferencePolicy.nextAttemptAt(tx.referenceAttempts + 1, now, random),
      );
      return { type: 'PENDING_REFERENCE', enteredNow: false };
    }
  }
}
