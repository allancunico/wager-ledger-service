import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { logger } from './application/observability/logger';
import { loadEnv } from './infrastructure/config/env';
import { ApiExceptionFilter } from './interfaces/http/api-exception.filter';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.useGlobalFilters(app.get(ApiExceptionFilter));

  if (env.ROLES.includes('api')) {
    await app.listen(env.PORT);
  } else {
    await app.init();
  }

  // Autenticação desligada por decisão (ARCHITECTURE.md 3.9); o providerId segue no contrato do corpo.
  logger.warn({ component: 'auth' }, 'authentication disabled; no-op provider identity is active');
  logger.info({ component: 'boot', roles: env.ROLES }, 'application started');
}

bootstrap().catch((error) => {
  logger.error({ err: error, component: 'boot' }, 'application startup failed');
  process.exit(1);
});
