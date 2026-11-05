import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { ModulesContainer, Reflector } from '@nestjs/core';
import { sign } from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHENTICATED_KEY, IS_PUBLIC, PERMISSIONS_KEY } from '../src/modules/auth/decorators';
import { PERMISSIONS } from '../src/seed/reference-data';
import { API_PREFIX } from '../src/app.factory';
import { createUser, JWT_SECRET, provision, signIn, startApi, type TestApi } from './api-helpers';
import { ok } from './finance-helpers';

interface Route { method: string; path: string; kind: 'public' | 'authenticated' | 'permissions' | 'undeclared' | 'conflict'; permissions: string[]; where: string }

const METHODS: Record<number, string> = { [RequestMethod.GET]: 'GET', [RequestMethod.POST]: 'POST', [RequestMethod.PUT]: 'PUT', [RequestMethod.PATCH]: 'PATCH', [RequestMethod.DELETE]: 'DELETE', [RequestMethod.ALL]: 'ALL', [RequestMethod.OPTIONS]: 'OPTIONS', [RequestMethod.HEAD]: 'HEAD' };
const join2 = (...p: string[]) => '/' + p.map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');

/** Every HTTP route the application registers, with how it is protected. */
function discoverRoutes(api: TestApi): Route[] {
  const reflector = new Reflector();
  const routes: Route[] = [];
  for (const mod of api.app.get(ModulesContainer).values()) {
    for (const wrapper of mod.controllers.values()) {
      const cls = wrapper.metatype as Function | null;
      if (!cls) continue;
      const base = Reflect.getMetadata(PATH_METADATA, cls);
      if (base === undefined) continue;
      for (const name of Object.getOwnPropertyNames(cls.prototype)) {
        const handler = cls.prototype[name];
        if (typeof handler !== 'function' || name === 'constructor') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        const sub = Reflect.getMetadata(PATH_METADATA, handler);
        const isPublic = !!reflector.getAllAndOverride<boolean>(IS_PUBLIC, [handler, cls]);
        const authed = !!reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, [handler, cls]);
        const perms = reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [handler, cls]) ?? [];
        const declared = [isPublic, authed, perms.length > 0].filter(Boolean).length;
        const kind = declared > 1 ? 'conflict' : isPublic ? 'public' : authed ? 'authenticated' : perms.length ? 'permissions' : 'undeclared';
        routes.push({ method: METHODS[method], path: join2(API_PREFIX, [base].flat()[0] as string, [sub].flat()[0] as string), kind, permissions: perms, where: `${cls.name}.${name}` });
      }
    }
  }
  return routes.sort((a, b) => (a.path + a.method).localeCompare(b.path + b.method));
}

const ID = '11111111-1111-4111-8111-111111111111';
const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, ID);
const label = (r: Route) => `${r.method} ${r.path}`;

/** The only routes anyone may call without signing in. Adding to this list is a deliberate security decision. */
const PUBLIC_ROUTES = ['GET /api/v1/downloads/:token', 'GET /api/v1/health', 'POST /api/v1/auth/login', 'POST /api/v1/auth/refresh'];

describe('security review', () => {
  let api: TestApi;
  let routes: Route[];
  let owner: string; let ownerId: string; let tenantId: string;

  beforeAll(async () => {
    api = await startApi({ CORS_ORIGINS: 'http://localhost:5173' });
    routes = discoverRoutes(api);
    tenantId = (await provision(api, 'sec', 'owner@sec.test')).tenantId;
    owner = (await signIn(api, 'owner@sec.test')).accessToken;
    ownerId = (await ok(api.req('get', '/auth/me', owner))).user.id;
  }, 60_000);
  afterAll(async () => api.close());

  const call = (r: Route, token?: string) => {
    const req = api.http[r.method.toLowerCase() as 'get'](concrete(r.path));
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  describe('every route declares who may call it', () => {
    it('finds the whole API', () => {
      expect(routes.length).toBeGreaterThan(100);
      expect(new Set(routes.map(label)).size).toBe(routes.length); // no duplicate routes
    });

    it('has no route without an access rule, and none with contradictory rules', () => {
      expect(routes.filter((r) => r.kind === 'undeclared').map((r) => `${label(r)} (${r.where})`)).toEqual([]);
      expect(routes.filter((r) => r.kind === 'conflict').map((r) => `${label(r)} (${r.where})`)).toEqual([]);
    });

    it('exposes exactly the intended public routes', () => {
      expect(routes.filter((r) => r.kind === 'public').map(label).sort()).toEqual([...PUBLIC_ROUTES].sort());
    });

    it('limits "any signed-in member" routes to harmless reads and the caller\'s own account', () => {
      const authed = routes.filter((r) => r.kind === 'authenticated').map(label).sort();
      expect(authed).toEqual([
        'GET /api/v1/auth/me', 'GET /api/v1/branches', 'GET /api/v1/currencies', 'GET /api/v1/exchange-rates',
        'GET /api/v1/exchange-rates/latest', 'GET /api/v1/financial-categories', 'GET /api/v1/payment-methods', 'GET /api/v1/settings/tax', 'GET /api/v1/tenant', 'POST /api/v1/auth/logout',
        'POST /api/v1/auth/change-password', 'POST /api/v1/auth/switch-tenant',
      ].sort());
      // every non-GET route that any member can call is part of the caller's own session/account
      expect(routes.filter((r) => r.kind === 'authenticated' && r.method !== 'GET').every((r) => r.path.startsWith('/api/v1/auth/'))).toBe(true);
    });

    it('only asks for permissions that exist', () => {
      const known = new Set(Object.keys(PERMISSIONS));
      const unknown = routes.flatMap((r) => r.permissions.filter((p) => !known.has(p)).map((p) => `${label(r)} needs ${p}`));
      expect(unknown).toEqual([]);
    });

    it('guards every state-changing route with a permission (never just "signed in") outside the own-account routes', () => {
      const weak = routes.filter((r) => r.method !== 'GET' && r.kind !== 'permissions' && !r.path.startsWith('/api/v1/auth/') && r.kind !== 'public');
      expect(weak.map(label)).toEqual([]);
    });
  });

  describe('callers without credentials', () => {
    it('are refused everywhere except the public routes', async () => {
      const protectedRoutes = routes.filter((r) => r.kind !== 'public');
      const bad: string[] = [];
      for (const r of protectedRoutes) {
        const res = await call(r);
        if (res.status !== 401 || res.body?.error?.code !== 'UNAUTHENTICATED') bad.push(`${label(r)} -> ${res.status}`);
      }
      expect(bad).toEqual([]);
    }, 120_000);

    it('are refused with forged, tampered, expired or malformed tokens too', async () => {
      const probe = routes.find((r) => r.path === '/api/v1/clients' && r.method === 'GET')!;
      const claims = { sub: ownerId, tid: tenantId };
      const [h, p, s] = owner.split('.');
      const tokens: Record<string, string> = {
        'signed with another secret': sign(claims, 'another-secret-another-secret-another-secret', { expiresIn: 300 }),
        'expired': sign(claims, JWT_SECRET, { expiresIn: -10 }),
        'alg none': `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`,
        'payload swapped, signature kept': `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), sub: ID })).toString('base64url')}.${s}`,
        'refresh-style garbage': 'not-a-jwt',
        'empty bearer': '',
      };
      for (const [why, t] of Object.entries(tokens)) {
        const res = await api.http.get(probe.path).set('Authorization', `Bearer ${t}`);
        expect(res.status, why).toBe(401);
      }
      expect((await api.http.get(probe.path).set('Authorization', owner)).status).toBe(401); // missing "Bearer"
      expect((await api.http.get(probe.path).set('Cookie', `access_token=${owner}`)).status).toBe(401); // never read from cookies
      expect((await api.http.get(`${probe.path}?access_token=${owner}`)).status).toBe(401); // never from the URL
    });

    it('cannot use a download token as a login token, or the reverse', async () => {
      const probe = routes.find((r) => r.path === '/api/v1/clients' && r.method === 'GET')!;
      const downloadLike = sign({ sub: ownerId, tid: tenantId, aud: 'download', doc: ID }, JWT_SECRET, { expiresIn: 60 });
      expect((await api.http.get(probe.path).set('Authorization', `Bearer ${downloadLike}`)).status).toBe(401);
      expect((await api.http.get(`/${API_PREFIX}/downloads/${owner}`)).status).toBeGreaterThanOrEqual(400);
      expect((await api.http.get(`/${API_PREFIX}/downloads/garbage`)).status).toBeLessThan(500);
    });
  });

  describe('a signed-in member with no permissions at all', () => {
    it('is refused on every permission-protected route, and sees nothing', async () => {
      const role = await ok(api.req('post', '/roles', owner).send({ code: 'NOBODY', name: 'Nobody', permissionCodes: [] }));
      const user = await ok(api.req('post', '/users', owner).send({ email: 'nobody@sec.test', firstName: 'No', lastName: 'Body', password: 'Correct-Horse-9', roleIds: [role.id] }));
      expect(user.id).toBeTruthy();
      const nobody = (await signIn(api, 'nobody@sec.test')).accessToken;
      const bad: string[] = [];
      for (const r of routes.filter((x) => x.kind === 'permissions')) {
        const res = await call(r, nobody);
        if (res.status !== 403 || res.body?.error?.code !== 'PERMISSION_DENIED') bad.push(`${label(r)} -> ${res.status}`);
      }
      expect(bad).toEqual([]);
    }, 120_000);

    it('holding one permission still cannot reach routes that need another', async () => {
      const only = await ok(api.req('post', '/roles', owner).send({ code: 'READ_CLIENTS', name: 'Read clients', permissionCodes: ['clients.view'] }));
      await ok(api.req('post', '/users', owner).send({ email: 'reader@sec.test', firstName: 'Re', lastName: 'Ader', password: 'Correct-Horse-9', roleIds: [only.id] }));
      const t = (await signIn(api, 'reader@sec.test')).accessToken;
      const bad: string[] = [];
      for (const r of routes.filter((x) => x.kind === 'permissions' && !x.permissions.every((p) => p === 'clients.view'))) {
        const res = await call(r, t);
        if (res.status !== 403) bad.push(`${label(r)} -> ${res.status}`);
      }
      expect(bad).toEqual([]);
    }, 120_000);

    it('treats a permission change as effective immediately, with no stale access', async () => {
      const role = await ok(api.req('post', '/roles', owner).send({ code: 'TEMP', name: 'Temp', permissionCodes: ['clients.view'] }));
      await ok(api.req('post', '/users', owner).send({ email: 'temp@sec.test', firstName: 'Te', lastName: 'Mp', password: 'Correct-Horse-9', roleIds: [role.id] }));
      const t = (await signIn(api, 'temp@sec.test')).accessToken;
      expect((await api.req('get', '/clients', t)).status).toBe(200);
      await ok(api.req('put', `/roles/${role.id}/permissions`, owner).send({ permissionCodes: [] }));
      expect((await api.req('get', '/clients', t)).status).toBe(403);
    });
  });

  describe('transport and error hygiene', () => {
    it('sends hardening headers and does not announce the framework', async () => {
      const res = await api.http.get(`/${API_PREFIX}/health`);
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBeDefined();
      expect(res.headers['strict-transport-security']).toBeDefined();
      expect(res.headers['content-security-policy']).toBeDefined();
    });

    it('allows cross-origin browsers only from the configured origins', async () => {
      const bad = await api.http.options(`/${API_PREFIX}/clients`).set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'GET');
      expect(bad.headers['access-control-allow-origin']).toBeUndefined();
      const good = await api.http.get(`/${API_PREFIX}/health`).set('Origin', 'http://localhost:5173');
      expect(good.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(good.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('never leaks stack traces, file paths, SQL or framework names in errors', async () => {
      const responses = [
        await api.http.get(`/${API_PREFIX}/no-such-route`),
        await api.req('get', '/clients/not-a-uuid', owner),
        await api.req('post', '/clients', owner).send({ name: 12345 }),
        await api.req('post', '/clients', owner).set('Content-Type', 'application/json').send('{"broken": '),
        await api.req('get', `/clients/${ID}`, owner),
        await api.req('get', '/clients?sort=passwordHash:asc&limit=-1', owner),
      ];
      for (const r of responses) {
        const text = JSON.stringify(r.body) + r.text;
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
        expect(text).not.toMatch(/\bat\s+\S+\s+\(|node_modules|\.ts:\d+|C:\\|\/home\/|prisma|SQLITE|SELECT |stack/i);
        expect(r.body.error?.code).toBeTruthy();
      }
    });

    it('rejects oversized JSON bodies', async () => {
      const res = await api.req('post', '/clients', owner).send({ name: 'x'.repeat(2_000_000) });
      expect(res.status).toBe(413);
    });

    it('slows down password guessing', async () => {
      const strict = await startApi({ RATE_LIMIT_AUTH: '4' });
      try {
        await provision(strict, 'sec-rate', 'owner@sec-rate.test');
        const codes: number[] = [];
        for (let i = 0; i < 8; i++) codes.push((await strict.req('post', '/auth/login').send({ email: 'owner@sec-rate.test', password: 'wrong-password-1' })).status);
        expect(codes.slice(0, 4)).toEqual([401, 401, 401, 401]);
        expect(codes.slice(4).every((c) => c === 429)).toBe(true);
        // and a correct password is refused too once throttled: guessing cannot continue by luck
        expect((await strict.req('post', '/auth/login').send({ email: 'owner@sec-rate.test', password: 'Correct-Horse-9' })).status).toBe(429);
      } finally { await strict.close(); process.env.RATE_LIMIT_AUTH = '100000'; /* the throttler reads process.env */ }
    });

    it('gives the same answer for an unknown user and a wrong password', async () => {
      const a = await api.req('post', '/auth/login').send({ email: 'nobody-here@sec.test', password: 'Whatever-123' });
      const b = await api.req('post', '/auth/login').send({ email: 'owner@sec.test', password: 'Whatever-123' });
      expect([a.status, b.status]).toEqual([401, 401]);
      expect(a.body.error).toEqual(b.body.error);
    });
  });

  describe('secrets never leave the server', () => {
    it('keeps password hashes, token hashes and storage paths out of every read response', async () => {
      const client = await ok(api.req('post', '/clients', owner).send({ name: 'Leak Test Co', type: 'COMPANY' }));
      const urls = ['/auth/me', '/users', `/users/${ownerId}`, '/roles', '/tenant', '/branches', '/clients', `/clients/${client.id}`, '/audit-logs?limit=100', '/notifications'];
      for (const u of urls) {
        const res = await api.req('get', u, owner);
        if (res.status === 404) continue;
        const text = res.text;
        expect(text, u).not.toMatch(/passwordHash|tokenHash|"storageKey"|\$argon2|\$2[aby]\$|refreshToken|JWT_ACCESS_SECRET/);
        expect(text, u).not.toContain(JWT_SECRET);
      }
    });

    it('does not put credentials into the audit trail', async () => {
      await signIn(api, 'owner@sec.test');
      const logs = await api.prisma.auditLog.findMany({ where: { tenantId } });
      expect(logs.length).toBeGreaterThan(0);
      for (const l of logs) expect(JSON.stringify([l.beforeData, l.afterData])).not.toMatch(/Correct-Horse|password|\$argon2|eyJ[A-Za-z0-9_-]{20,}/i);
    });
  });

  describe('source-level checks', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === 'generated' ? [] : files(p)) : p.endsWith('.ts') ? [p] : [];
    });
    const src = files(join(__dirname, '..', 'src')).map((p) => ({ p: p.replace(/\\/g, '/').split('/src/')[1], text: readFileSync(p, 'utf8') }));

    it('uses unsafe raw SQL only where reviewed, and always with bound values', () => {
      const users = src.filter((f) => /\$(query|execute)RawUnsafe/.test(f.text)).map((f) => f.p).sort();
      expect(users).toEqual(['common/search.ts', 'database/client.ts']);
      const search = src.find((f) => f.p === 'common/search.ts')!.text;
      expect(search).toContain('...params'); // values are passed as bound parameters
      expect(search).not.toMatch(/\$\{\s*(term|query|search|q|o\.term)\b/); // never interpolated into the SQL text
    });

    it('has no dynamic code execution, shell access or unreviewed network calls', () => {
      const offenders = src.filter((f) => /\beval\(|new Function\(|child_process|\bexec(Sync)?\(|\bspawn(Sync)?\(|vm\.runIn/.test(f.text)).map((f) => f.p);
      expect(offenders).toEqual([]);
    });

    it('keeps secrets out of source', () => {
      const hits = src.filter((f) => /(secret|password|apikey|api_key)\s*[:=]\s*['"][A-Za-z0-9+/_-]{16,}['"]/i.test(f.text)).map((f) => f.p);
      expect(hits).toEqual([]);
    });
  });
});

describe('audit log endpoint', () => {
  let api: TestApi;
  let owner: string; let ownerId: string; let tenantId: string;
  let other: string;
  let officer: string;

  beforeAll(async () => {
    api = await startApi();
    tenantId = (await provision(api, 'aud', 'owner@aud.test')).tenantId;
    await provision(api, 'aud-b', 'owner@aud-b.test');
    owner = (await signIn(api, 'owner@aud.test')).accessToken;
    other = (await signIn(api, 'owner@aud-b.test')).accessToken;
    ownerId = (await ok(api.req('get', '/auth/me', owner))).user.id;
    await createUser(api, owner, 'officer@aud.test', 'CLEARANCE_OFFICER');
    officer = (await signIn(api, 'officer@aud.test')).accessToken;
    await ok(api.req('post', '/clients', owner).send({ name: 'Audited Client', type: 'COMPANY' }));
  }, 60_000);
  afterAll(async () => api.close());

  const list = (q = '', t = owner) => api.req('get', `/audit-logs${q}`, t);

  it('needs the audit.view permission', async () => {
    expect((await list('', officer)).status).toBe(403);
    expect((await api.req('get', '/audit-logs')).status).toBe(401);
    expect((await list('', owner)).status).toBe(200);
  });

  it('lists the newest entries first with who did it, and what changed', async () => {
    const res = await ok(list('?limit=100'));
    expect(res.length).toBeGreaterThan(3);
    const times = res.map((r: any) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const created = res.find((r: any) => r.action === 'CLIENT_CREATED');
    expect(created).toMatchObject({ entityType: 'Client', actor: { id: ownerId, email: 'owner@aud.test' } });
    expect(created.after).toMatchObject({ name: 'Audited Client' });
    expect(created.actor.name).toBe('Owner aud');
  });

  it('filters by action, entity, actor and time, and pages', async () => {
    const byAction = await ok(list('?action=CLIENT_CREATED'));
    expect(byAction.every((r: any) => r.action === 'CLIENT_CREATED')).toBe(true);
    expect(byAction).toHaveLength(1);
    const byEntity = await ok(list(`?entityType=Client&entityId=${byAction[0].entityId}`));
    expect(byEntity.map((r: any) => r.id)).toEqual([byAction[0].id]);
    expect((await ok(list(`?actorUserId=${ownerId}`))).length).toBeGreaterThan(0);
    expect(await ok(list(`?actorUserId=${ID}`))).toEqual([]);
    expect(await ok(list('?from=2999-01-01T00:00:00Z'))).toEqual([]);
    expect((await ok(list('?to=2999-01-01T00:00:00Z'))).length).toBeGreaterThan(0);
    const p1 = await list('?limit=2&page=1'); const p2 = await list('?limit=2&page=2');
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.meta).toMatchObject({ page: 1, limit: 2 });
    expect(p1.body.meta.total).toBeGreaterThan(2);
    expect(p1.body.data[0].id).not.toBe(p2.body.data[0].id);
    expect((await list('?limit=1000')).status).toBe(400);
    expect((await list('?from=yesterday')).status).toBe(400);
  });

  it('shows an office only its own entries', async () => {
    const mine = await ok(list('?limit=100'));
    const theirs = await ok(list('?limit=100', other));
    expect(theirs.length).toBeGreaterThan(0);
    const mineIds = new Set(mine.map((r: any) => r.id));
    expect(theirs.some((r: any) => mineIds.has(r.id))).toBe(false);
    expect(JSON.stringify(theirs)).not.toContain('Audited Client');
    expect(theirs.every((r: any) => r.actor === null || r.actor.email.endsWith('@aud-b.test'))).toBe(true);
    // asking for another office's entry by id returns nothing, not an error that confirms it exists
    const foreign = await api.prisma.auditLog.findFirstOrThrow({ where: { tenantId: { not: tenantId, } } });
    expect(await ok(list(`?entityId=${foreign.entityId ?? ID}&entityType=${foreign.entityType}`))).toEqual([]);
  });

  it('records sign-ins and the permission-sensitive actions it was asked to keep', async () => {
    const actions = new Set((await ok(list('?limit=100'))).map((r: any) => r.action));
    for (const a of ['TENANT_PROVISIONED', 'AUTH_LOGIN', 'USER_CREATED', 'CLIENT_CREATED']) expect(actions.has(a), a).toBe(true);
  });

  it('is read-only: no route can change it, and the database refuses too', async () => {
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await api.req(m, '/audit-logs', owner).send({})).status, m).toBeGreaterThanOrEqual(404);
      expect((await api.req(m, `/audit-logs/${ID}`, owner).send({})).status, m).toBe(404);
    }
    const row = await api.prisma.auditLog.findFirstOrThrow({ where: { tenantId } });
    await expect(api.prisma.auditLog.update({ where: { id: row.id }, data: { action: 'TAMPERED' } })).rejects.toThrow();
    await expect(api.prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow();
    expect((await api.prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).action).toBe(row.action);
  });
});
