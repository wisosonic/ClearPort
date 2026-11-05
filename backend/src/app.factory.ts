import 'reflect-metadata';
import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import type { Env } from './config/env';

export const API_PREFIX = 'api/v1';

/** Builds (but does not listen) the application — shared by main.ts and the API tests. */
export async function createApp(env: Env): Promise<INestApplication> {
  // Rate-limit env is read per request by the throttler; keep it in sync with the validated env.
  process.env.RATE_LIMIT_DEFAULT = String(env.RATE_LIMIT_DEFAULT);
  process.env.RATE_LIMIT_AUTH = String(env.RATE_LIMIT_AUTH);

  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    logger: env.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'],
  });
  app.setGlobalPrefix(API_PREFIX);
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);
  app.use(helmet());
  app.useBodyParser('json', { limit: '1mb' });

  const origins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  app.enableCors({
    origin: origins.length > 0 ? origins : false, // no CORS unless explicitly configured
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  app.disable('x-powered-by');
  app.enableShutdownHooks();
  return app;
}
