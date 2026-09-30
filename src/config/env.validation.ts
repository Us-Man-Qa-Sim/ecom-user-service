import { z } from 'zod';

const numericString = (defaultValue: number) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((value, ctx) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: `${value} is not a number` });
        return z.NEVER;
      }
      return parsed;
    });

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  GRPC_HOST: z.string().default('0.0.0.0'),
  GRPC_PORT: numericString(5001),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: numericString(8081),

  DATABASE_URL: z.string().url(),

  KAFKA_BROKERS: z.string().default('localhost:9092'),
  KAFKA_CLIENT_ID: z.string().default('user-service'),

  // Outbox relay knobs. Disabling is useful in tests and in one-off admin
  // containers that share the codebase but should not publish. Defaults are
  // conservative — 250 ms polling and batches of 32 keep transactions short so
  // FOR UPDATE SKIP LOCKED locks are released quickly.
  OUTBOX_RELAY_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  OUTBOX_RELAY_POLL_INTERVAL_MS: numericString(250),
  OUTBOX_RELAY_BATCH_SIZE: numericString(32),
  OUTBOX_RELAY_ERROR_BACKOFF_MS: numericString(5_000),

  JWT_PRIVATE_KEY_PATH: z.string().optional(),
  JWT_PUBLIC_KEY_PATH: z.string().optional(),
  JWT_ACCESS_TTL_SECONDS: numericString(900),
  JWT_REFRESH_TTL_SECONDS: numericString(60 * 60 * 24 * 30),
  JWT_ISSUER: z.string().default('user-service'),
  JWT_AUDIENCE: z.string().default('ecom-api'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return parsed.data;
}
