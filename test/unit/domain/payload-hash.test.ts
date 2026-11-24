import { describe, expect, test } from 'bun:test';
import { canonicalJson, hashPayload } from '../../../src/domain/wagering/payload-hash';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction';
import { brl, usd } from '../helpers/builders';

const base = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: brl('25.00'),
};

describe('canonicalJson', () => {
  test('ordena as chaves recursivamente e não usa espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('a ordem de inserção não importa', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test('omite undefined, preserva null e a ordem dos arrays', () => {
    expect(canonicalJson({ a: undefined, b: null, c: [3, 1, 2] })).toBe('{"b":null,"c":[3,1,2]}');
  });

  test('escapa strings como JSON', () => {
    expect(canonicalJson({ a: 'x"y\n' })).toBe('{"a":"x\\"y\\n"}');
  });
});

describe('hashPayload', () => {
  test('é SHA-256 em hexadecimal minúsculo e determinístico', () => {
    const hash = hashPayload(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayload({ ...base })).toBe(hash);
  });

  test('"25" e "25.00" geram o mesmo hash (o dinheiro entra normalizado)', () => {
    expect(hashPayload({ ...base, money: brl('25') })).toBe(hashPayload(base));
    expect(hashPayload({ ...base, money: brl('25.0') })).toBe(hashPayload(base));
  });

  test('a ordem das chaves do objeto de entrada não altera o hash', () => {
    const reordered = {
      money: base.money,
      kind: base.kind,
      gameId: base.gameId,
      roundId: base.roundId,
      walletId: base.walletId,
      playerId: base.playerId,
      externalTransactionId: base.externalTransactionId,
      providerId: base.providerId,
    };
    expect(hashPayload(reordered)).toBe(hashPayload(base));
  });

  test('referência ausente e referência undefined explícita são equivalentes', () => {
    expect(hashPayload({ ...base, referenceExternalTransactionId: undefined })).toBe(
      hashPayload(base),
    );
  });

  test.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: 'wallet-2' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'other-game' }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['valor', { money: brl('25.01') }],
    ['moeda', { money: usd('25.00') }],
    ['referência', { referenceExternalTransactionId: 'bet-1' }],
  ])('mudar %s muda o hash (payload divergente é conflito, não replay)', (_field, change) => {
    expect(hashPayload({ ...base, ...change })).not.toBe(hashPayload(base));
  });

  test('referências diferentes geram hashes diferentes', () => {
    expect(hashPayload({ ...base, referenceExternalTransactionId: 'a' })).not.toBe(
      hashPayload({ ...base, referenceExternalTransactionId: 'b' }),
    );
  });

  test('campos extras, como a idempotency key, não influenciam (não fazem parte do contrato)', () => {
    const withTransport = { ...base, idempotencyKey: 'k', messageId: 'm' } as typeof base;
    expect(hashPayload(withTransport)).toBe(hashPayload(base));
  });

  test('vetor fixo: o algoritmo não muda silenciosamente entre versões', () => {
    // Se este teste quebrar, o formato do hash mudou: transações antigas deixariam de bater.
    expect(
      canonicalJson({
        providerId: base.providerId,
        externalTransactionId: base.externalTransactionId,
        playerId: base.playerId,
        walletId: base.walletId,
        roundId: base.roundId,
        gameId: base.gameId,
        kind: base.kind,
        money: base.money.toJSON(),
        referenceExternalTransactionId: null,
      }),
    ).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET",' +
        '"money":{"amount":"25.00","currency":"BRL"},"playerId":"player-1",' +
        '"providerId":"provider-a","referenceExternalTransactionId":null,' +
        '"roundId":"round-987","walletId":"wallet-1"}',
    );
  });
});
