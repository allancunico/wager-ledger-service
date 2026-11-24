import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './infrastructure/config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();

  if (env.ROLES.includes('api')) {
    await app.listen(env.PORT);
  } else {
    await app.init();
  }

  // Autenticação desligada por decisão (ARCHITECTURE.md 3.9). O AuthGuard no-op entra na etapa 4.
  console.warn('[auth] autenticação DESLIGADA: adaptador no-op ativo');
  console.log(`[boot] papéis ativos: ${env.ROLES.join(', ')}`);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exit(1);
});
