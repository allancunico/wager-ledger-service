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
import { SYSTEM_CLOCK } from './application/shared/clock';
import { WagerTransactionService } from './application/wagering/wager-transaction-service';
import { WalletService } from './application/wallets/wallet-service';
import type { Env } from './infrastructure/config/env';
import { loadEnv } from './infrastructure/config/env';
import { createOrm } from './infrastructure/database/orm';
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
