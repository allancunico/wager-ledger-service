import type { Env } from '../../infrastructure/config/env';
import { logger } from '../observability/logger';
import { WagerTransactionService } from './wager-transaction-service';

/** Poller independente: pode rodar em cada instância, com SKIP LOCKED no PostgreSQL. */
export class PendingReferenceWorker {
  private readonly abortController = new AbortController();
  private loopPromise?: Promise<void>;

  constructor(
    private readonly transactions: WagerTransactionService,
    private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.ROLES.includes('workers')) this.loopPromise = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.abortController.abort();
    await this.loopPromise;
  }

  private async run(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      let processed = 0;
      try {
        processed = await this.transactions.reprocessPendingReferences(
          this.env.PENDING_REFERENCE_BATCH_SIZE,
        );
      } catch (error) {
        logger.error(
          {
            component: 'pending-reference-worker',
            error: error instanceof Error ? error.name : 'UnknownError',
            code: getErrorCode(error),
          },
          'pending reference batch failed',
        );
      }
      if (processed > 0) continue;
      await delay(this.env.WORKER_POLL_INTERVAL_MS, this.abortController.signal);
    }
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return String((error as { code: unknown }).code);
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      clearTimeout(timeout);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
