import { describe, expect, test } from 'bun:test';
import { computeBackoffMs } from '../../../src/domain/shared/backoff';
import { FixedClock } from '../../../src/domain/shared/clock';

const options = { baseSeconds: 5, maxSeconds: 300, jitterRatio: 0.2 };
const middle = () => 0.5; // jitter zero: (0.5 * 2 - 1) = 0

describe('computeBackoffMs', () => {
  test('cresce exponencialmente a partir da base, sem jitter', () => {
    const delays = [0, 1, 2, 3, 4].map((attempt) => computeBackoffMs(attempt, options, middle));
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
  });

  test('respeita o teto', () => {
    expect(computeBackoffMs(6, options, middle)).toBe(300_000); // 5 * 64 = 320 -> 300
    expect(computeBackoffMs(50, options, middle)).toBe(300_000);
    expect(computeBackoffMs(10_000, options, middle)).toBe(300_000);
  });

  test('jitter fica dentro de ±20%', () => {
    expect(computeBackoffMs(0, options, () => 0)).toBe(4_000); // -20%
    expect(computeBackoffMs(0, options, () => 0.999999)).toBe(6_000); // ~+20%
    for (let i = 0; i <= 100; i++) {
      const delay = computeBackoffMs(2, options, () => i / 100);
      expect(delay).toBeGreaterThanOrEqual(16_000);
      expect(delay).toBeLessThanOrEqual(24_000);
    }
  });

  test('jitter zero é determinístico', () => {
    const noJitter = { ...options, jitterRatio: 0 };
    expect(computeBackoffMs(3, noJitter)).toBe(40_000);
    expect(computeBackoffMs(3, noJitter)).toBe(40_000);
  });

  test.each([-1, 1.5, Number.NaN])('rejeita attempt inválido %p', (attempt) => {
    expect(() => computeBackoffMs(attempt, options)).toThrow(RangeError);
  });

  test('rejeita configuração incoerente', () => {
    expect(() => computeBackoffMs(0, { ...options, baseSeconds: 0 })).toThrow(RangeError);
    expect(() => computeBackoffMs(0, { ...options, maxSeconds: 1 })).toThrow(RangeError);
    expect(() => computeBackoffMs(0, { ...options, jitterRatio: 1 })).toThrow(RangeError);
    expect(() => computeBackoffMs(0, { ...options, jitterRatio: -0.1 })).toThrow(RangeError);
  });
});

describe('FixedClock', () => {
  test('devolve cópias e avança sob controle', () => {
    const clock = new FixedClock(new Date('2026-01-01T00:00:00.000Z'));
    const first = clock.now();
    first.setUTCFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:01.500Z');
    clock.set(new Date('2030-05-05T05:05:05.000Z'));
    expect(clock.now().toISOString()).toBe('2030-05-05T05:05:05.000Z');
  });
});
