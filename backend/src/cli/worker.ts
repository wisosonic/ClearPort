import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadEnv } from '../config/env';

/**
 * Runs ONLY the background job worker (no HTTP server). Use it when the API is started with
 * JOB_WORKER=false so jobs (reminders, housekeeping, ...) cannot slow requests down.
 *
 *   JOB_WORKER=false npm start      # API
 *   npm run worker                  # worker
 */
async function main() {
  const env = loadEnv({ ...process.env, JOB_WORKER: 'true' } as NodeJS.ProcessEnv);
  const app = await NestFactory.createApplicationContext(AppModule.register(env), { logger: ['log', 'warn', 'error'] });
  app.enableShutdownHooks();
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
