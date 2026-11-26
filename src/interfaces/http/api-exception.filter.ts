import { ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  TransactionNotFoundError,
  WalletMissingError,
} from '../../application/wagering/wager-transaction-service';
import {
  InvalidCursorError,
  WalletAlreadyExistsError,
  WalletNotFoundError,
} from '../../application/wallets/wallet-service';
import {
  CurrencyMismatchError,
  DomainError,
  InsufficientFundsError,
  InvalidInputError,
  InvalidMoneyError,
  MissingReferenceError,
  OpeningNotAllowedError,
} from '../../domain/shared/errors';
import { HttpInputError } from './wager-transaction.controller';

const TRANSIENT_SOCKET_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EHOSTDOWN',
  'ENETDOWN',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
]);
const TRANSIENT_POSTGRES_DRIVER_CODES = new Set([
  'ERR_POSTGRES_CONNECTION_CLOSED',
  'ERR_POSTGRES_CONNECTION_FAILED',
  'ERR_POSTGRES_CONNECTION_REFUSED',
  'ERR_POSTGRES_CONNECTION_TIMEOUT',
  'ERR_POSTGRES_IDLE_TIMEOUT',
  'ERR_POSTGRES_LIFETIME_TIMEOUT',
]);

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const mapped = mapError(exception);
    if (mapped.status === 503) response.setHeader('Retry-After', '1');
    response
      .status(mapped.status)
      .type('application/problem+json')
      .json({
        code: mapped.code,
        message: mapped.message,
        retryable: mapped.retryable,
        ...(typeof request.headers['x-correlation-id'] === 'string'
          ? { correlationId: request.headers['x-correlation-id'] }
          : {}),
      });
  }
}

function mapError(error: unknown): {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
} {
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error as { status?: unknown }).status === 400
  ) {
    return {
      status: 400,
      code: 'INVALID_PAYLOAD',
      message: 'Corpo HTTP inválido',
      retryable: false,
    };
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    const response = error.getResponse();
    const message =
      typeof response === 'string'
        ? response
        : typeof response === 'object' && response !== null && 'message' in response
          ? String((response as { message: unknown }).message)
          : error.message;
    return {
      status,
      code:
        status === 400 ? 'INVALID_PAYLOAD' : status === 503 ? 'SERVICE_UNAVAILABLE' : 'HTTP_ERROR',
      message,
      retryable: status === 503,
    };
  }
  if (error instanceof HttpInputError)
    return { status: 400, code: 'INVALID_PAYLOAD', message: error.message, retryable: false };
  if (error instanceof WalletAlreadyExistsError)
    return {
      status: 409,
      code: 'WALLET_ALREADY_EXISTS',
      message: 'A wallet deste player e moeda já existe',
      retryable: false,
    };
  if (error instanceof IdempotencyConflictError)
    return {
      status: 409,
      code: 'IDEMPOTENCY_KEY_CONFLICT',
      message: 'A Idempotency-Key já foi usada com outro payload',
      retryable: false,
    };
  if (error instanceof ExternalTransactionConflictError)
    return {
      status: 409,
      code: 'EXTERNAL_TRANSACTION_CONFLICT',
      message: 'A transação externa já foi registrada com outra Idempotency-Key',
      retryable: false,
    };
  if (
    error instanceof WalletNotFoundError ||
    error instanceof WalletMissingError ||
    error instanceof TransactionNotFoundError
  )
    return { status: 404, code: 'NOT_FOUND', message: 'Recurso não encontrado', retryable: false };
  if (error instanceof InvalidCursorError)
    return { status: 400, code: 'INVALID_CURSOR', message: 'Cursor inválido', retryable: false };
  if (
    error instanceof InvalidMoneyError ||
    error instanceof CurrencyMismatchError ||
    error instanceof InvalidInputError ||
    error instanceof MissingReferenceError ||
    error instanceof OpeningNotAllowedError
  ) {
    return { status: 400, code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof InsufficientFundsError)
    return {
      status: 500,
      code: error.code,
      message: 'Invariante financeira violada',
      retryable: false,
    };
  if (error instanceof DomainError)
    return { status: 500, code: error.code, message: 'Falha interna', retryable: false };

  const sqlState = findSqlState(error);
  const connectionCode = findConnectionErrorCode(error);
  if (
    sqlState === '55P03' ||
    sqlState === '40P01' ||
    sqlState.startsWith('08') ||
    sqlState === '57P01' ||
    sqlState === '57P02' ||
    sqlState === '57P03' ||
    connectionCode !== undefined
  ) {
    return {
      status: 503,
      code:
        sqlState === '55P03'
          ? 'LOCK_TIMEOUT'
          : sqlState === '40P01'
            ? 'DEADLOCK'
            : 'DATABASE_UNAVAILABLE',
      message: 'Serviço temporariamente indisponível',
      retryable: true,
    };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Falha interna', retryable: false };
}

function findSqlState(error: unknown): string {
  return getNestedErrorCodes(error).find((code) => /^[0-9A-Z]{5}$/.test(code)) ?? '';
}

/**
 * Node's `pg` driver reports socket codes (for example ECONNREFUSED); Bun's PostgreSQL client
 * uses ERR_POSTGRES_CONNECTION_* codes. Both represent infrastructure outages to API callers.
 */
function findConnectionErrorCode(error: unknown): string | undefined {
  return getNestedErrorCodes(error).find(
    (code) => TRANSIENT_SOCKET_ERROR_CODES.has(code) || TRANSIENT_POSTGRES_DRIVER_CODES.has(code),
  );
}

function getNestedErrorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);

    const candidate = current as {
      code?: unknown;
      errno?: unknown;
      sqlState?: unknown;
      cause?: unknown;
      driverException?: unknown;
      originalError?: unknown;
    };
    for (const value of [candidate.code, candidate.errno, candidate.sqlState]) {
      if (typeof value === 'string') codes.push(value);
    }
    pending.push(candidate.cause, candidate.driverException, candidate.originalError);
  }

  return codes;
}
