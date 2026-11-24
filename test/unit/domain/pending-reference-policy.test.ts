import { describe, expect, test } from 'bun:test';
import { PendingReferencePolicy } from '../../../src/domain/wagering/pending-reference-policy';
import { T0 } from '../helpers/builders';

const options = {
  ttlSeconds: 3600,
  backoff: { baseSeconds: 5, maxSeconds: 300, jitterRatio: 0.2 },
};
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

describe('PendingReferencePolicy', () => {
  const policy = new PendingReferencePolicy(options);

  test('expira exatamente no TTL, contado a partir de createdAt', () => {
    expect(policy.isExpired(T0, at(3599))).toBe(false);
    expect(policy.isExpired(T0, at(3599.999))).toBe(false);
    expect(policy.isExpired(T0, at(3600))).toBe(true);
    expect(policy.isExpired(T0, at(86_400))).toBe(true);
  });

  test('nextAttemptAt soma o backoff ao instante informado', () => {
    const middle = () => 0.5;
    expect(policy.nextAttemptAt(0, at(100), middle).getTime()).toBe(at(105).getTime());
    expect(policy.nextAttemptAt(1, at(100), middle).getTime()).toBe(at(110).getTime());
    expect(policy.nextAttemptAt(10, at(100), middle).getTime()).toBe(at(400).getTime()); // teto de 300s
  });

  test('o jitter desloca o instante dentro de ±20%', () => {
    expect(policy.nextAttemptAt(0, T0, () => 0).getTime()).toBe(at(4).getTime());
    expect(policy.nextAttemptAt(0, T0, () => 0.999999).getTime()).toBeLessThanOrEqual(
      at(6).getTime(),
    );
  });

  test('recusa TTL não positivo', () => {
    expect(() => new PendingReferencePolicy({ ...options, ttlSeconds: 0 })).toThrow(RangeError);
  });

  test('TTL curto, como nos testes de integração', () => {
    const short = new PendingReferencePolicy({ ...options, ttlSeconds: 2 });
    expect(short.isExpired(T0, at(1))).toBe(false);
    expect(short.isExpired(T0, at(2))).toBe(true);
  });
});
