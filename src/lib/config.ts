import { existsSync } from 'node:fs';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  APP_ORIGIN: z.string().url().default('http://localhost:3000'),
  MASTER_KEY: z.string().optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  STORAGE_DIR: z.string().min(1).default('./.data/storage'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  EXPORT_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(30),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  STORAGE_MAX_BYTES: z.coerce.number().int().min(1).default(10 * 1024 * 1024),
  IDEMPOTENCY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(168),
  // Provisional owner-review window; DEC-05 remains pending.
  SUBMISSION_SNAPSHOT_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  // Exact origins allowed for owner-configured OpenAI-compatible providers.
  // This prevents a saved provider URL from becoming an arbitrary SSRF target.
  AI_ALLOWED_ENDPOINT_ORIGINS: z.string().default('https://api.openai.com/v1'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | null = null;

function loadDotEnv(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (!existsSync('.env')) return;
  try {
    process.loadEnvFile('.env');
  } catch {
    // A malformed .env must fail loudly through schema validation below.
  }
}

export function getConfig(): AppConfig {
  if (cached) return cached;
  loadDotEnv();
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    !parsed.data.SESSION_SECRET
  ) {
    throw new Error('Invalid configuration: SESSION_SECRET is required in production');
  }
  cached = parsed.data;
  return cached;
}

/** Test-only helper; production code never mutates cached configuration. */
export function resetConfigForTests(): void {
  cached = null;
}

export function isProduction(): boolean {
  return getConfig().NODE_ENV === 'production';
}

export function appOrigin(): string {
  return getConfig().APP_ORIGIN.replace(/\/$/, '');
}
