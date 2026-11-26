import type { MikroORM } from '@mikro-orm/postgresql';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationMetrics } from '../../application/observability/application-metrics';
import { DATABASE_ORM } from '../../infrastructure/di/tokens';
import { SqsTransactionConsumer } from '../../infrastructure/messaging/sqs-transaction-consumer';

@Controller()
export class MetricsController {
  constructor(
    @Inject(ApplicationMetrics) private readonly metrics: ApplicationMetrics,
    @Inject(DATABASE_ORM) private readonly orm: MikroORM,
    @Inject(SqsTransactionConsumer) private readonly transactionsQueue: SqsTransactionConsumer,
  ) {}

  @Get('metrics')
  async scrape(@Res() response: Response) {
    const [outbox] = await this.orm.em
      .fork()
      .execute<{ pending: string; oldestAgeSeconds: string }[]>(
        `select count(*)::text as pending,
              coalesce(extract(epoch from (now() - min(occurred_at))), 0)::text as "oldestAgeSeconds"
         from outbox_messages where published_at is null`,
      );
    this.metrics.setOutboxState(
      Number(outbox?.pending ?? 0),
      Number(outbox?.oldestAgeSeconds ?? 0),
    );
    this.metrics.setDeadLetterMessages(await this.transactionsQueue.getDeadLetterVisibleCount());
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    return response.send(await this.metrics.metrics());
  }
}
