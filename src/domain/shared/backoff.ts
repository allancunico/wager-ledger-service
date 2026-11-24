export interface BackoffOptions {
  /** Atraso base, em segundos, da primeira repetição. */
  baseSeconds: number;
  /** Teto do atraso, em segundos (aplicado antes do jitter). */
  maxSeconds: number;
  /** Fração de jitter simétrico, ex.: 0.2 = ±20%. */
  jitterRatio: number;
}

/**
 * Backoff exponencial com teto e jitter: `min(base * 2^attempt, max) * (1 ± jitter)`.
 *
 * `attempt` é a quantidade de tentativas já feitas (0 = primeira repetição).
 * `random` devolve um número em [0, 1) e é injetado para o resultado ser determinístico nos testes.
 * Resultado em milissegundos.
 */
export function computeBackoffMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new RangeError(`attempt deve ser inteiro >= 0, recebido ${attempt}`);
  }
  if (options.baseSeconds <= 0 || options.maxSeconds < options.baseSeconds) {
    throw new RangeError('backoff exige 0 < baseSeconds <= maxSeconds');
  }
  if (options.jitterRatio < 0 || options.jitterRatio >= 1) {
    throw new RangeError('jitterRatio deve estar em [0, 1)');
  }

  // Limita o expoente: 2^attempt estouraria para valores grandes, e o teto já domina bem antes.
  const exponent = Math.min(attempt, 30);
  const capped = Math.min(options.baseSeconds * 2 ** exponent, options.maxSeconds);
  const jitter = 1 + (random() * 2 - 1) * options.jitterRatio;
  return Math.round(capped * jitter * 1000);
}
