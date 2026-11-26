import type { MikroORM } from '@mikro-orm/postgresql';
import {
  Controller,
  Get,
  Inject,
  MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { OutboxPublisher, OutboxPublisherWorker } from './application/messaging/outbox-publisher';
import { SYSTEM_CLOCK } from './application/shared/clock';
import { PendingReferenceWorker } from './application/wagering/pending-reference-worker';
import { WagerTransactionService } from './application/wagering/wager-transaction-service';
import { WalletService } from './application/wallets/wallet-service';
import type { Env } from './infrastructure/config/env';
import { loadEnv } from './infrastructure/config/env';
import { createOrm } from './infrastructure/database/orm';
import { createSqsEventQueue } from './infrastructure/messaging/sqs-event-queue';
import {
  createSqsTransactionConsumerClient,
  SqsTransactionConsumer,
} from './infrastructure/messaging/sqs-transaction-consumer';
import { ApiExceptionFilter } from './interfaces/http/api-exception.filter';
import {
  AuthGuard,
  NoopProviderIdentity,
  PROVIDER_IDENTITY_PORT,
} from './interfaces/http/auth.guard';
import { CorrelationIdMiddleware } from './interfaces/http/correlation-id.middleware';
import {
  WAGER_TRANSACTION_SERVICE,
  WagerTransactionController,
} from './interfaces/http/wager-transaction.controller';
import { WALLET_SERVICE, WalletController } from './interfaces/http/wallet.controller';

export const ENV = Symbol('ENV');
export const DATABASE_ORM = Symbol('DATABASE_ORM');
export const EVENT_QUEUE = Symbol('EVENT_QUEUE');

@Controller('health')
class HealthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(DATABASE_ORM) private readonly orm: MikroORM,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok', roles: this.env.ROLES };
  }

  @Get('ready')
  async ready() {
    await this.orm.em.fork().execute('select 1');
    return { status: 'ready' };
  }
}

class OrmLifecycle {
  constructor(private readonly orm: MikroORM) {}
  async onApplicationShutdown() {
    await this.orm.close(true);
  }
}

@Module({
  controllers: [HealthController, WalletController, WagerTransactionController],
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    { provide: DATABASE_ORM, useFactory: async () => createOrm() },
    { provide: EVENT_QUEUE, useFactory: (env: Env) => createSqsEventQueue(env), inject: [ENV] },
    {
      provide: OutboxPublisher,
      useFactory: (orm: MikroORM, queue: ReturnType<typeof createSqsEventQueue>, env: Env) =>
        new OutboxPublisher(
          orm,
          queue,
          SYSTEM_CLOCK,
          env.OUTBOX_BATCH_SIZE,
          env.OUTBOX_CLAIM_LEASE_SECONDS,
        ),
      inject: [DATABASE_ORM, EVENT_QUEUE, ENV],
    },
    {
      provide: OutboxPublisherWorker,
      useFactory: (publisher: OutboxPublisher, env: Env) =>
        new OutboxPublisherWorker(publisher, env),
      inject: [OutboxPublisher, ENV],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (service: WagerTransactionService, env: Env) =>
        new PendingReferenceWorker(service, env),
      inject: [WAGER_TRANSACTION_SERVICE, ENV],
    },
    {
      provide: SqsTransactionConsumer,
      useFactory: (service: WagerTransactionService, env: Env) =>
        new SqsTransactionConsumer(
          createSqsTransactionConsumerClient(env),
          env.SQS_TRANSACTIONS_QUEUE,
          env.SQS_CONSUMER_NAME,
          service,
          env,
        ),
      inject: [WAGER_TRANSACTION_SERVICE, ENV],
    },
    {
      provide: WALLET_SERVICE,
      useFactory: (orm: MikroORM) => new WalletService(orm, SYSTEM_CLOCK),
      inject: [DATABASE_ORM],
    },
    {
      provide: WAGER_TRANSACTION_SERVICE,
      useFactory: (orm: MikroORM, env: Env) => new WagerTransactionService(orm, SYSTEM_CLOCK, env),
      inject: [DATABASE_ORM, ENV],
    },
    {
      provide: OrmLifecycle,
      useFactory: (orm: MikroORM) => new OrmLifecycle(orm),
      inject: [DATABASE_ORM],
    },
    ApiExceptionFilter,
    { provide: PROVIDER_IDENTITY_PORT, useClass: NoopProviderIdentity },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
