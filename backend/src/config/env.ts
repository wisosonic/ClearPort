import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  STORAGE_ROOT: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().positive().max(200).default(25),
  DOWNLOAD_LINK_TTL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  // Browser used for PDF generation (auto-detected when empty)
  CHROME_PATH: z.string().optional(),
  // Needed when Chrome runs as root in a container/VM; leave off on a normal desktop or a dedicated user
  PDF_NO_SANDBOX: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  // Background jobs run inside the API process unless JOB_WORKER=false (then run `npm run worker`). Off in tests.
  JOB_WORKER: z.enum(['true', 'false']).optional(),
  JOB_POLL_MS: z.coerce.number().int().min(100).default(2000),
  JOB_LOCK_TIMEOUT_SECONDS: z.coerce.number().int().min(10).default(300),
  // Encrypted backups. A nightly backup job runs only when BACKUP_DIR and BACKUP_PASSPHRASE are both set.
  BACKUP_DIR: z.string().optional(),
  BACKUP_PASSPHRASE: z.string().min(12).optional(),
  BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
  TASK_REMINDER_LEAD_HOURS: z.coerce.number().min(0.1).max(720).default(24),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  CORS_ORIGINS: z.string().default(''),
  // Rate limits (per minute, per IP). Auth endpoints get the strict limit.
  RATE_LIMIT_DEFAULT: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH: z.coerce.number().int().positive().default(10),
}).transform((e) => ({ ...e, JOB_WORKER: e.JOB_WORKER ? e.JOB_WORKER === 'true' : e.NODE_ENV !== 'test' }));

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

export const ENV = Symbol('ENV');
