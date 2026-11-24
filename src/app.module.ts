import { Controller, Get, Inject, Module } from '@nestjs/common';
import { type Env, loadEnv } from './infrastructure/config/env';

export const ENV = Symbol('ENV');

// Sem emitDecoratorMetadata no Bun: toda injeção usa @Inject(TOKEN) explícito.
@Controller('health')
class HealthController {
  constructor(@Inject(ENV) private readonly env: Env) {}

  @Get('live')
  live() {
    return { status: 'ok', roles: this.env.ROLES };
  }
}

@Module({
  controllers: [HealthController],
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
})
export class AppModule {}
