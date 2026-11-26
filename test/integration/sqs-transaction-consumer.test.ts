import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { v7 as uuidv7 } from 'uuid';
import {
  type SubmitWagerInput,
  WagerTransactionService,
} from '../../src/application/wagering/wager-transaction-service';
import { WalletService } from '../../src/application/wallets/wallet-service';
import { Money } from '../../src/domain/shared/money';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import { loadEnv } from '../../src/infrastructure/config/env';
import { createOrm } from '../../src/infrastructure/database/orm';
import {
  createSqsTransactionConsumerClient,
  SqsTransactionConsumer,
} from '../../src/infrastructure/messaging/sqs-transaction-consumer';
import {
  InboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from '../../src/infrastructure/persistence/records';
import { createTestDatabase } from './helpers/database';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
let secondOrm: Awaited<ReturnType<typeof createOrm>>;
let env: ReturnType<typeof loadEnv>;
let sqs: SQSClient;
let queueName: string;
let queueUrl: string;
let dlqName: string;
let transactions: WagerTransactionService;
let secondTransactions: WagerTransactionService;
let consumer: SqsTransactionConsumer;

describe('SQS transaction consumer', () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    secondOrm = await createOrm(database.databaseUrl);
    env = loadEnv();
    sqs = createSqsTransactionConsumerClient(env);
    const queues = await createFifoQueuePair(sqs, 'consumer-it', 5, 30);
    queueName = queues.queueName;
    queueUrl = queues.queueUrl;
    dlqName = queues.dlqName;
    transactions = new WagerTransactionService(database.orm, systemClock, env);
    secondTransactions = new WagerTransactionService(secondOrm, systemClock, env);
    consumer = new SqsTransactionConsumer(sqs, queueName, 'consumer-it', transactions, {
      ...env,
      SQS_MAX_RECEIVE_COUNT: 5,
    });
  }, 30_000);

  afterAll(async () => {
    await secondOrm?.close(true);
    await database?.close();
    if (sqs) {
      await deleteQueueIfPresent(sqs, queueName);
      await deleteQueueIfPresent(sqs, dlqName);
      sqs.destroy();
    }
  });

  test('processes a FIFO message, ACKs only after commit, and deduplicates a redelivery', async () => {
    const { wallet, input } = await createWalletAndInput('50.00', '12.50');
    const body = JSON.stringify({ ...input, money: input.money.toJSON() });
    const sent = await sendMessage(queueUrl, wallet.id, body);
    const received = await receiveOne(queueUrl);
    expect(received?.MessageId).toBe(sent.MessageId);
    expect(received?.ReceiptHandle).toBeDefined();

    expect(
      await consumer.consumeOne({
        body: received?.Body,
        messageId: received?.MessageId,
        receiptHandle: received?.ReceiptHandle,
        attributes: received?.Attributes,
      }),
    ).toBe(true);

    const balance = await readBalance(wallet.id);
    expect(balance).toBe('37.50');
    expect(
      await database.orm.em.fork().count(InboxMessageRecord, {
        consumerName: 'consumer-it',
        messageId: sent.MessageId,
        processedAt: { $ne: null },
      }),
    ).toBe(1);

    const replay = await secondTransactions.submitFromQueue(input, {
      consumerName: 'consumer-it',
      messageId: sent.MessageId ?? 'missing-message-id',
    });
    expect(replay.duplicateMessage).toBe(true);
    expect(await readBalance(wallet.id)).toBe('37.50');
    expect(await receiveOne(queueUrl)).toBeUndefined();

    // A second broker message with the same business idempotency key has a new SQS MessageId.
    await sendMessage(queueUrl, wallet.id, body);
    const businessReplay = await receiveOne(queueUrl);
    expect(
      await consumer.consumeOne({
        body: businessReplay?.Body,
        messageId: businessReplay?.MessageId,
        receiptHandle: businessReplay?.ReceiptHandle,
        attributes: businessReplay?.Attributes,
      }),
    ).toBe(true);
    expect(await readBalance(wallet.id)).toBe('37.50');
    const transactionCount = await database.orm.em.fork().count(WagerTransactionRecord, {
      providerId: input.providerId,
      idempotencyKey: input.idempotencyKey,
    });
    expect(transactionCount).toBe(1);
  }, 15_000);

  test('concurrent delivery of the same message ID across service instances debits once', async () => {
    const { wallet, input } = await createWalletAndInput('30.00', '8.00');
    const message = { consumerName: 'consumer-it', messageId: `concurrent-${uuidv7()}` };
    const results = await Promise.all([
      transactions.submitFromQueue(input, message),
      secondTransactions.submitFromQueue(input, message),
    ]);

    expect(results.filter((result) => result.duplicateMessage)).toHaveLength(1);
    expect(await readBalance(wallet.id)).toBe('22.00');
    expect(
      await database.orm.em.fork().count(InboxMessageRecord, {
        consumerName: message.consumerName,
        messageId: message.messageId,
      }),
    ).toBe(1);
    expect(
      await database.orm.em.fork().count(WagerTransactionRecord, {
        providerId: input.providerId,
        idempotencyKey: input.idempotencyKey,
      }),
    ).toBe(1);
  }, 10_000);

  test('crash after commit is recovered by inbox deduplication on redelivery', async () => {
    const crashQueue = await createFifoQueuePair(sqs, 'crash-it', 5, 1);
    let recoveryWorker: Bun.Subprocess | undefined;
    try {
      const { wallet, input } = await createWalletAndInput('50.00', '12.50');
      const body = JSON.stringify({ ...input, money: input.money.toJSON() });
      await sendMessage(crashQueue.queueUrl, wallet.id, body);

      const crashingWorker = spawnConsumer(database.databaseUrl, crashQueue.queueName, true);
      expect(await waitForExit(crashingWorker, 20_000)).toBe(137);
      expect(await readBalance(wallet.id)).toBe('37.50');
      expect(
        await database.orm.em.fork().count(WagerTransactionRecord, {
          providerId: input.providerId,
          idempotencyKey: input.idempotencyKey,
        }),
      ).toBe(1);

      recoveryWorker = spawnConsumer(database.databaseUrl, crashQueue.queueName, false);
      await waitForQueueEmpty(crashQueue.queueUrl, 15_000);
      expect(await readBalance(wallet.id)).toBe('37.50');
      expect(
        await database.orm.em.fork().count(InboxMessageRecord, {
          consumerName: env.SQS_CONSUMER_NAME,
          processedAt: { $ne: null },
        }),
      ).toBe(1);
    } finally {
      if (recoveryWorker?.exitCode === null) recoveryWorker.kill('SIGTERM');
      if (recoveryWorker) await recoveryWorker.exited;
      await deleteQueueIfPresent(sqs, crashQueue.queueName);
      await deleteQueueIfPresent(sqs, crashQueue.dlqName);
    }
  }, 40_000);

  test('ACKs a business rejection as a terminal result without changing balance', async () => {
    const { wallet, input } = await createWalletAndInput('5.00', '8.00');
    const body = JSON.stringify({ ...input, money: input.money.toJSON() });
    await sendMessage(queueUrl, wallet.id, body);
    const received = await receiveOne(queueUrl);

    expect(
      await consumer.consumeOne({
        body: received?.Body,
        messageId: received?.MessageId,
        receiptHandle: received?.ReceiptHandle,
        attributes: received?.Attributes,
      }),
    ).toBe(true);
    const transaction = await database.orm.em.fork().findOneOrFail(WagerTransactionRecord, {
      providerId: input.providerId,
      idempotencyKey: input.idempotencyKey,
    });
    expect(transaction.status).toBe('REJECTED');
    expect(await readBalance(wallet.id)).toBe('5.00');
    expect(await receiveOne(queueUrl)).toBeUndefined();
  }, 10_000);

  test('records FAILED after exhausted transient attempts and leaves the SQS message unacked', async () => {
    const { wallet, input } = await createWalletAndInput('20.00', '3.00');
    const body = JSON.stringify({ ...input, money: input.money.toJSON() });
    await sendMessage(queueUrl, wallet.id, body);
    const received = await receiveOne(queueUrl);
    const originalSubmit = transactions.submitFromQueue.bind(transactions);
    transactions.submitFromQueue = async () => {
      throw new Error('simulated transient database failure');
    };
    try {
      expect(
        await consumer.consumeOne({
          body: received?.Body,
          messageId: received?.MessageId,
          receiptHandle: received?.ReceiptHandle,
          attributes: { ApproximateReceiveCount: String(env.SQS_MAX_RECEIVE_COUNT) },
        }),
      ).toBe(false);
    } finally {
      transactions.submitFromQueue = originalSubmit;
    }

    const transaction = await database.orm.em.fork().findOneOrFail(WagerTransactionRecord, {
      providerId: input.providerId,
      idempotencyKey: input.idempotencyKey,
    });
    expect(transaction.status).toBe('FAILED');
    expect(transaction.failureCode).toBe('PROCESSING_ATTEMPTS_EXHAUSTED');
    expect(await readBalance(wallet.id)).toBe('20.00');
  }, 10_000);

  test('redrives malformed JSON to the DLQ after the queue receive limit', async () => {
    const malformedQueue = await createFifoQueuePair(sqs, 'invalid-it', 2, 0);
    try {
      const malformedConsumer = new SqsTransactionConsumer(
        sqs,
        malformedQueue.queueName,
        'consumer-invalid-it',
        transactions,
        { ...env, SQS_MAX_RECEIVE_COUNT: 2 },
      );
      await sendMessage(malformedQueue.queueUrl, uuidv7(), '{not-json');

      let deadLetterCount = 0;
      for (let attempt = 0; attempt < 8 && deadLetterCount === 0; attempt += 1) {
        const received = await receiveOne(malformedQueue.queueUrl);
        if (received) {
          expect(
            await malformedConsumer.consumeOne({
              body: received.Body,
              messageId: received.MessageId,
              receiptHandle: received.ReceiptHandle,
              attributes: received.Attributes,
            }),
          ).toBe(false);
        }
        const counts = await sqs.send(
          new GetQueueAttributesCommand({
            QueueUrl: malformedQueue.dlqUrl,
            AttributeNames: ['ApproximateNumberOfMessages'],
          }),
        );
        deadLetterCount = Number(counts.Attributes?.ApproximateNumberOfMessages ?? 0);
      }
      expect(deadLetterCount).toBe(1);
    } finally {
      await deleteQueueIfPresent(sqs, malformedQueue.queueName);
      await deleteQueueIfPresent(sqs, malformedQueue.dlqName);
    }
  }, 20_000);
});

const systemClock = { now: () => new Date() };

async function createWalletAndInput(initialBalance: string, amount: string) {
  const playerId = uuidv7();
  const wallet = await new WalletService(databaseRef().orm, systemClock).create({
    playerId,
    initialBalance: Money.from({ amount: initialBalance, currency: 'BRL' }),
  });
  const input: SubmitWagerInput = {
    providerId: 'provider-sqs-it',
    externalTransactionId: `external-${uuidv7()}`,
    idempotencyKey: `key-${uuidv7()}`,
    playerId,
    walletId: wallet.id,
    roundId: 'round-sqs-it',
    gameId: 'game-sqs-it',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: 'BRL' }),
    correlationId: `correlation-${uuidv7()}`,
  };
  return { wallet, input };
}

function databaseRef() {
  if (!database) throw new Error('Integration database not initialized');
  return database;
}

async function readBalance(walletId: string): Promise<string> {
  const wallet = await databaseRef().orm.em.fork().findOneOrFail(WalletRecord, { id: walletId });
  return wallet.balance;
}

async function sendMessage(queueUrl: string, groupId: string, body: string) {
  return sqsRef().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: uuidv7(),
    }),
  );
}

async function receiveOne(queueUrl: string) {
  const result = await sqsRef().send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return result.Messages?.[0];
}

async function createFifoQueuePair(
  client: SQSClient,
  prefix: string,
  maxReceiveCount: number,
  visibilityTimeout: number,
) {
  const suffix = uuidv7().replaceAll('-', '');
  const dlqName = `${prefix}-dlq-${suffix}.fifo`;
  const queueName = `${prefix}-${suffix}.fifo`;
  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true', ContentBasedDeduplication: 'false' },
    }),
  );
  const dlqUrl = dlq.QueueUrl;
  if (!dlqUrl) throw new Error(`SQS não criou a DLQ ${dlqName}`);
  const dlqAttributes = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }),
  );
  const dlqArn = dlqAttributes.Attributes?.QueueArn;
  if (!dlqArn) throw new Error(`SQS não retornou ARN da DLQ ${dlqName}`);
  const queue = await client.send(
    new CreateQueueCommand({
      QueueName: queueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(visibilityTimeout),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: String(maxReceiveCount),
        }),
      },
    }),
  );
  const queueUrl = queue.QueueUrl;
  if (!queueUrl) throw new Error(`SQS não criou a fila ${queueName}`);
  return { queueName, queueUrl, dlqName, dlqUrl };
}

async function deleteQueueIfPresent(client: SQSClient, queueName: string): Promise<void> {
  if (!queueName) return;
  const result = await client.send(new GetQueueUrlCommand({ QueueName: queueName }));
  if (result.QueueUrl) await client.send(new DeleteQueueCommand({ QueueUrl: result.QueueUrl }));
}

function sqsRef(): SQSClient {
  if (!sqs) throw new Error('SQS client not initialized');
  return sqs;
}

function spawnConsumer(
  databaseUrl: string,
  transactionsQueue: string,
  crashAfterCommit: boolean,
): Bun.Subprocess {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const childEnv: Record<string, string> = {
    ...inherited,
    DATABASE_URL: databaseUrl,
    ROLES: 'consumer',
    SQS_TRANSACTIONS_QUEUE: transactionsQueue,
    SQS_CONSUMER_WAIT_SECONDS: '1',
  };
  if (crashAfterCommit) childEnv.FAULT = 'crash_after_commit';
  else delete childEnv.FAULT;
  return Bun.spawn([process.execPath, 'run', 'src/main.ts'], {
    cwd: process.cwd(),
    env: childEnv,
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

async function waitForExit(child: Bun.Subprocess, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null) await Bun.sleep(50);
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await child.exited;
    throw new Error('Consumer não encerrou após o fault injection');
  }
  return child.exitCode;
}

async function waitForQueueEmpty(queueUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  let stableEmptyChecks = 0;
  while (Date.now() < deadline) {
    const result = await sqsRef().send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );
    const visible = Number(result.Attributes?.ApproximateNumberOfMessages ?? 0);
    const inFlight = Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
    if (visible === 0 && inFlight === 0 && Date.now() - startedAt >= 2500) {
      stableEmptyChecks += 1;
      if (stableEmptyChecks >= 3) return;
    } else {
      stableEmptyChecks = 0;
    }
    await Bun.sleep(200);
  }
  throw new Error('A mensagem não foi removida da fila após a recuperação');
}
