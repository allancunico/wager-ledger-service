import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import type { Env } from '../config/env';

export interface EventQueuePort {
  publish(input: { eventId: string; groupKey: string; body: string }): Promise<void>;
}

export class SqsEventQueue implements EventQueuePort {
  private queueUrlPromise?: Promise<string>;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async checkReady(): Promise<void> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.getQueueUrl(),
        AttributeNames: ['QueueArn'],
      }),
    );
    if (!result.Attributes?.QueueArn) {
      throw new Error(`SQS não retornou ARN para a fila ${this.queueName}`);
    }
  }

  async publish(input: { eventId: string; groupKey: string; body: string }): Promise<void> {
    const queueUrl = await this.getQueueUrl();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: input.body,
        MessageGroupId: input.groupKey,
        MessageDeduplicationId: input.eventId,
      }),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.client.destroy();
  }

  private async getQueueUrl(): Promise<string> {
    this.queueUrlPromise ??= this.client
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then((result) => {
        if (!result.QueueUrl) throw new Error(`SQS não retornou URL para a fila ${this.queueName}`);
        return result.QueueUrl;
      })
      .catch((error: unknown) => {
        this.queueUrlPromise = undefined;
        throw error;
      });
    return this.queueUrlPromise;
  }
}

export function createSqsEventQueue(env: Env): SqsEventQueue {
  const explicitCredentials =
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : env.AWS_ENDPOINT_URL
        ? { accessKeyId: 'test', secretAccessKey: 'test' }
        : undefined;
  const client = new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    ...(explicitCredentials ? { credentials: explicitCredentials } : {}),
  });
  return new SqsEventQueue(client, env.SQS_EVENTS_QUEUE);
}
