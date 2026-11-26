import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { ApplicationMetrics } from '../../application/observability/application-metrics';
import { logger } from '../../application/observability/logger';
import { newId } from '../../application/shared/ids';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxMessageConflictError,
  type SubmitWagerInput,
  WagerTransactionService,
  WalletMissingError,
} from '../../application/wagering/wager-transaction-service';
import { DomainError } from '../../domain/shared/errors';
import { Money } from '../../domain/shared/money';
import { transactionMessageSchema } from '../../interfaces/messaging/transaction-message';
import type { Env } from '../config/env';

export class SqsTransactionConsumer {
  private readonly abortController = new AbortController();
  private loopPromise?: Promise<void>;
  private queueUrlPromise?: Promise<string>;
  private deadLetterUrlPromise?: Promise<string>;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
    private readonly consumerName: string,
    private readonly transactions: WagerTransactionService,
    private readonly env: Env,
    private readonly metrics?: ApplicationMetrics,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.ROLES.includes('consumer')) this.loopPromise = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.abortController.abort();
    await this.loopPromise;
    this.client.destroy();
  }

  async checkReady(): Promise<void> {
    await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.getQueueUrl(),
        AttributeNames: ['QueueArn'],
      }),
    );
  }

  async getDeadLetterVisibleCount(): Promise<number> {
    this.deadLetterUrlPromise ??= this.client
      .send(new GetQueueUrlCommand({ QueueName: this.env.SQS_TRANSACTIONS_DLQ }))
      .then((result) => {
        if (!result.QueueUrl) throw new Error('SQS não retornou URL da DLQ de transações');
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.deadLetterUrlPromise = undefined;
        throw error;
      });
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.deadLetterUrlPromise,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    return Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  /** Exposto para testes de integração sem depender do ciclo de polling. */
  async consumeOne(message: {
    body?: string;
    messageId?: string;
    receiptHandle?: string;
    attributes?: Record<string, string | undefined>;
  }): Promise<boolean> {
    if (!message.body || !message.messageId || !message.receiptHandle) return false;
    let input: SubmitWagerInput | undefined;
    let phase: 'decode' | 'process' | 'ack' = 'decode';
    try {
      const raw: unknown = JSON.parse(message.body);
      const parsed = transactionMessageSchema.safeParse(raw);
      if (!parsed.success) throw new PermanentQueueMessageError('INVALID_PAYLOAD');
      const correlationId = parsed.data.correlationId ?? newId();
      input = {
        ...parsed.data,
        kind: parsed.data.kind,
        money: Money.from(parsed.data.money),
        correlationId,
      };
      phase = 'process';
      await this.transactions.submitFromQueue(input, {
        consumerName: this.consumerName,
        messageId: message.messageId,
      });
      if (this.env.FAULT === 'crash_after_commit') {
        logger.error(
          {
            component: 'sqs-transaction-consumer',
            action: 'fault-crash-after-commit',
            messageId: message.messageId,
          },
          'fault injection: exiting after database commit and before SQS ACK',
        );
        process.exit(137);
      }
      phase = 'ack';
      await this.client.send(
        new DeleteMessageCommand({
          QueueUrl: await this.getQueueUrl(),
          ReceiptHandle: message.receiptHandle,
        }),
      );
      return true;
    } catch (error) {
      // Não apagar: o visibility timeout e a redrive policy levam a mensagem à DLQ após o limite.
      logger.error(
        {
          component: 'sqs-transaction-consumer',
          phase,
          messageId: message.messageId,
          error: error instanceof Error ? error.name : 'UnknownError',
          code: error instanceof PermanentQueueMessageError ? error.code : undefined,
        },
        'transaction message processing failed',
      );
      const receiveCount = Number(message.attributes?.ApproximateReceiveCount) || 1;
      this.metrics?.recordRetry('sqs');
      if (receiveCount >= this.env.SQS_MAX_RECEIVE_COUNT) this.metrics?.recordDeadLetter();
      if (
        input &&
        receiveCount >= this.env.SQS_MAX_RECEIVE_COUNT &&
        !isPermanentInputError(error)
      ) {
        try {
          await this.transactions.recordQueueAttemptsExhausted(input);
        } catch (failureError) {
          logger.error(
            {
              component: 'sqs-transaction-consumer',
              messageId: message.messageId,
              action: 'record-failed-best-effort',
              error: failureError instanceof Error ? failureError.name : 'UnknownError',
            },
            'could not persist exhausted transaction state',
          );
        }
      }
      return false;
    }
  }

  private async run(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const result = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: await this.getQueueUrl(),
            MaxNumberOfMessages: this.env.SQS_CONSUMER_BATCH_SIZE,
            WaitTimeSeconds: this.env.SQS_CONSUMER_WAIT_SECONDS,
            MessageAttributeNames: ['All'],
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
        );
        const messages = result.Messages ?? [];
        for (const [index, message] of messages.entries()) {
          if (this.abortController.signal.aborted) {
            await this.release(messages.slice(index));
            break;
          }
          await this.consumeOne({
            body: message.Body,
            messageId: message.MessageId,
            receiptHandle: message.ReceiptHandle,
            attributes: message.Attributes,
          });
        }
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        logger.error(
          {
            component: 'sqs-transaction-consumer',
            error: error instanceof Error ? error.name : 'UnknownError',
          },
          'SQS poll failed',
        );
        await delay(this.env.WORKER_POLL_INTERVAL_MS, this.abortController.signal);
      }
    }
  }

  private async getQueueUrl(): Promise<string> {
    this.queueUrlPromise ??= this.client
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then((result) => {
        if (!result.QueueUrl) throw new Error(`SQS não retornou URL para ${this.queueName}`);
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrlPromise = undefined;
        throw error;
      });
    return this.queueUrlPromise;
  }

  private async release(messages: { ReceiptHandle?: string }[]): Promise<void> {
    const queueUrl = await this.getQueueUrl();
    await Promise.all(
      messages
        .filter((message): message is { ReceiptHandle: string } => Boolean(message.ReceiptHandle))
        .map((message) =>
          this.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          ),
        ),
    );
  }
}

export class PermanentQueueMessageError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function isPermanentInputError(error: unknown): boolean {
  return (
    error instanceof PermanentQueueMessageError ||
    error instanceof DomainError ||
    error instanceof IdempotencyConflictError ||
    error instanceof ExternalTransactionConflictError ||
    error instanceof InboxMessageConflictError ||
    error instanceof WalletMissingError
  );
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        done();
      },
      { once: true },
    );
  });
}

export function createSqsTransactionConsumerClient(env: Env): SQSClient {
  const explicitCredentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : env.AWS_ENDPOINT_URL
        ? { accessKeyId: 'test', secretAccessKey: 'test' }
        : undefined;
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    ...(explicitCredentials ? { credentials: explicitCredentials } : {}),
  });
}
