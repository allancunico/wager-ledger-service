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
  SQS_TRANSACTIONS_QUEUE: z.string().default('wager-transactions.fifo'),
  SQS_TRANSACTIONS_DLQ: z.string().default('wager-transactions-dlq.fifo'),
  SQS_EVENTS_QUEUE: z.string().default('wager-events.fifo'),
  LOCK_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
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
