import { z } from 'zod';

const rolesSchema = z
  .string()
  .default('api,consumer,workers')
  .transform((value) =>
    value
      .split(',')
      .map((role) => role.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(['api', 'consumer', 'workers'])).min(1));

const envSchema = z.object({
  ROLES: rolesSchema,
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().default('us-east-1'),
  AWS_ENDPOINT_URL: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SQS_TRANSACTIONS_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_CONSUMER_NAME: z.string().min(1).max(255).default('wager-transactions-v1'),
  SQS_CONSUMER_BATCH_SIZE: z.coerce.number().int().positive().max(10).default(10),
  SQS_CONSUMER_WAIT_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  SQS_MAX_RECEIVE_COUNT: z.coerce.number().int().positive().default(5),
  SQS_EVENTS_QUEUE: z.string().default('wager-events.fifo'),
  LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  OUTBOX_CLAIM_LEASE_SECONDS: z.coerce.number().int().positive().default(30),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  PENDING_REFERENCE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  PENDING_REFERENCE_BACKOFF_BASE_SECONDS: z.coerce.number().positive().default(5),
  PENDING_REFERENCE_BACKOFF_MAX_SECONDS: z.coerce.number().positive().default(300),
  FAULT: z.enum(['crash_after_commit']).optional(),
});

export type Env = z.infer<typeof envSchema>;
export type Role = Env['ROLES'][number];

/** Valida as variáveis de ambiente no boot: falha rápido, com mensagem clara. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Configuração inválida: ${issues}`);
  }
  return parsed.data;
}
