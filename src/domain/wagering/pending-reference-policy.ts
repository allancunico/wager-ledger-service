import { type BackoffOptions, computeBackoffMs } from '../shared/backoff';

export interface PendingReferencePolicyOptions {
  /** Por quanto tempo esperamos a referência, contado a partir de `createdAt`. */
  ttlSeconds: number;
  backoff: BackoffOptions;
}

/**
 * Política de espera por uma referência ausente: TTL e backoff exponencial com jitter.
 *
 * Usa TTL, e não um número de tentativas, porque o que importa ao provedor é por quanto tempo
 * esperamos; o número de tentativas dependeria do intervalo do worker.
 */
export class PendingReferencePolicy {
  constructor(private readonly options: PendingReferencePolicyOptions) {
    if (options.ttlSeconds <= 0) {
      throw new RangeError('ttlSeconds deve ser positivo');
    }
  }

  isExpired(createdAt: Date, now: Date): boolean {
    return now.getTime() - createdAt.getTime() >= this.options.ttlSeconds * 1000;
  }

  /** Quando reavaliar, dado quantas reavaliações já aconteceram (0 na entrada em PENDING_REFERENCE). */
  nextAttemptAt(attempts: number, now: Date, random: () => number = Math.random): Date {
    return new Date(now.getTime() + computeBackoffMs(attempts, this.options.backoff, random));
  }
}
