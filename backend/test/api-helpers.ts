import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import supertest from 'supertest';
import { createApp, API_PREFIX } from '../src/app.factory';
import { loadEnv } from '../src/config/env';
import { PrismaService } from '../src/database/prisma.module';
import { ProvisioningService } from '../src/modules/tenants/provisioning.service';
import { freshDb, type TestDb } from './helpers';

export const PASSWORD = 'Correct-Horse-9';
export const JWT_SECRET = 'test-secret-test-secret-test-secret-123456';

export interface TestApi {
  app: INestApplication;
  /** raw supertest agent; paths are relative to /api/v1 */
  http: ReturnType<typeof supertest>;
  prisma: PrismaService['client'];
  provisioning: ProvisioningService;
  db: TestDb;
  /** private storage directory of this test app */
  storageRoot: string;
  close: () => Promise<void>;
  req: (method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, token?: string) => supertest.Test;
}

export async function startApi(envOverrides: Record<string, string> = {}): Promise<TestApi> {
  const db = await freshDb();
  await db.prisma.$disconnect(); // the app opens its own connection to the same file
  const storageRoot = mkdtempSync(join(tmpdir(), 'clearport-storage-'));
  const env = loadEnv({
    NODE_ENV: 'test', DATABASE_URL: db.url, STORAGE_ROOT: storageRoot, JWT_ACCESS_SECRET: JWT_SECRET,
    RATE_LIMIT_DEFAULT: '100000', RATE_LIMIT_AUTH: '100000', ...envOverrides,
  } as NodeJS.ProcessEnv);
  const app = await createApp(env);
  await app.init();
  const http = supertest(app.getHttpServer());
  return {
    app, http, db, storageRoot,
    prisma: app.get(PrismaService).client,
    provisioning: app.get(ProvisioningService),
    close: async () => {
      await app.close();
      await db.cleanup();
      rmSync(storageRoot, { recursive: true, force: true });
    },
    req: (method, path, token) => {
      const r = http[method](`/${API_PREFIX}${path}`);
      return token ? r.set('Authorization', `Bearer ${token}`) : r;
    },
  };
}

export async function provision(api: TestApi, slug: string, ownerEmail = `owner@${slug}.test`) {
  return api.provisioning.createTenant({
    name: `Office ${slug}`, slug, defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en',
    ownerEmail, ownerFirstName: 'Owner', ownerLastName: slug, ownerPassword: PASSWORD,
  });
}

export async function login(api: TestApi, email: string, tenantSlug?: string, password = PASSWORD) {
  const res = await api.req('post', '/auth/login').send({ email, password, tenantSlug });
  return res;
}

/** Logs in and returns the tokens, failing loudly if it does not work. */
export async function signIn(api: TestApi, email: string, tenantSlug?: string) {
  const res = await login(api, email, tenantSlug);
  if (res.status !== 200 || !res.body.data?.accessToken) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data as { accessToken: string; refreshToken: string };
}

export async function roleId(api: TestApi, code: string) {
  return (await api.prisma.role.findFirstOrThrow({ where: { tenantId: null, code } })).id;
}

/** Creates a user through the real API as `ownerToken` and returns the created user. */
export async function createUser(
  api: TestApi, ownerToken: string, email: string, roleCode: string,
  extra: Record<string, unknown> = {},
) {
  const res = await api.req('post', '/users', ownerToken).send({
    email, firstName: 'Emp', lastName: roleCode, password: PASSWORD, roleIds: [await roleId(api, roleCode)], ...extra,
  });
  if (res.status !== 201) throw new Error(`createUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { id: string; email: string };
}
