import { createHash } from 'node:crypto';
import type { Money } from '../shared/money';
import type { WagerTransactionKind } from './wager-transaction';

/**
 * Campos de NEGÓCIO que identificam o conteúdo de uma submissão. O header `Idempotency-Key` e
 * metadados de transporte (messageId, occurredAt, correlationId) ficam de fora de propósito:
 * a mesma operação reenviada por outro canal tem que gerar o mesmo hash.
 */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico: objetos com chaves em ordem lexicográfica (recursivamente), sem espaços,
 * `undefined` omitido. Arrays preservam a ordem.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Algoritmo (v1):
 *   1. monta o objeto com os campos de negócio acima; `money` entra normalizado (`amount` com
 *      escala 2, então "25" e "25.00" produzem o mesmo hash) e `referenceExternalTransactionId`
 *      ausente entra como `null`;
 *   2. serializa como JSON canônico (chaves ordenadas);
 *   3. SHA-256 sobre os bytes UTF-8, em hexadecimal minúsculo.
 */
export function hashPayload(fields: PayloadHashFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money.toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId ?? null,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
