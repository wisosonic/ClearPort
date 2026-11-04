import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, JWT_SECRET, login, PASSWORD, provision, signIn, startApi, type TestApi } from './api-helpers';

describe('authentication API', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await provision(api, 'alpha', 'owner@alpha.test');
  });
  afterAll(async () => api.close());

  it('serves a public health check in the standard envelope', async () => {
    const res = await api.req('get', '/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { status: 'ok' } });
  });

  it('rejects requests without a token with a coded error envelope', async () => {
    const res = await api.req('get', '/auth/me');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false, error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: [] },
    });
  });

  it('rejects garbage and tampered tokens', async () => {
    expect((await api.req('get', '/auth/me', 'not-a-jwt')).status).toBe(401);
    const { accessToken } = await signIn(api, 'owner@alpha.test');
    const tampered = accessToken.slice(0, -4) + 'AAAA';
    const res = await api.req('get', '/auth/me', tampered);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('logs in and returns the profile, office and permissions — never password data', async () => {
    const tokens = await signIn(api, 'owner@alpha.test');
    const me = await api.req('get', '/auth/me', tokens.accessToken);
    expect(me.status).toBe(200);
    expect(me.body.data.user.email).toBe('owner@alpha.test');
    expect(me.body.data.tenant.slug).toBe('alpha');
    expect(me.body.data.roles.map((r: any) => r.code)).toEqual(['OWNER']);
    expect(me.body.data.permissions).toContain('accounting.post');
    expect(JSON.stringify(me.body)).not.toMatch(/passwordHash|argon2/i);
  });

  it('stores the password as Argon2id and only a hash of the refresh token', async () => {
    const user = await api.prisma.user.findUniqueOrThrow({ where: { email: 'owner@alpha.test' } });
    expect(user.passwordHash.startsWith('$argon2id$')).toBe(true);
    const tokens = await signIn(api, 'owner@alpha.test');
    const stored = await api.prisma.refreshSession.findMany({ where: { userId: user.id } });
    expect(stored.some((s) => s.tokenHash === tokens.refreshToken)).toBe(false);
    expect(stored.every((s) => /^[0-9a-f]{64}$/.test(s.tokenHash))).toBe(true);
  });

  it('gives the same generic error for a wrong password and an unknown e-mail', async () => {
    const wrong = await login(api, 'owner@alpha.test', undefined, 'Wrong-Password-1');
    const unknown = await login(api, 'nobody@alpha.test');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('records failed and successful logins in the audit log without secrets', async () => {
    await login(api, 'owner@alpha.test', undefined, 'Wrong-Password-1');
    const logs = await api.prisma.auditLog.findMany({ where: { action: { in: ['AUTH_LOGIN_FAILED', 'AUTH_LOGIN'] } } });
    expect(logs.some((l) => l.action === 'AUTH_LOGIN_FAILED')).toBe(true);
    expect(logs.some((l) => l.action === 'AUTH_LOGIN')).toBe(true);
    expect(JSON.stringify(logs)).not.toMatch(new RegExp(`${PASSWORD}|Wrong-Password`));
  });

  it('validates input with a field-level error list', async () => {
    const res = await api.req('post', '/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: any) => d.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  describe('refresh-token rotation', () => {
    it('rotates on every refresh and the new access token works', async () => {
      const t1 = await signIn(api, 'owner@alpha.test');
      const r = await api.req('post', '/auth/refresh').send({ refreshToken: t1.refreshToken });
      expect(r.status).toBe(200);
      expect(r.body.data.refreshToken).not.toBe(t1.refreshToken);
      expect((await api.req('get', '/auth/me', r.body.data.accessToken)).status).toBe(200);
    });

    it('treats reuse of an old refresh token as theft and kills the whole session', async () => {
      const t1 = await signIn(api, 'owner@alpha.test');
      const t2 = (await api.req('post', '/auth/refresh').send({ refreshToken: t1.refreshToken })).body.data;
      // attacker replays the old token
      const replay = await api.req('post', '/auth/refresh').send({ refreshToken: t1.refreshToken });
      expect(replay.status).toBe(401);
      // the legitimate newer token and its access token are dead as well
      expect((await api.req('post', '/auth/refresh').send({ refreshToken: t2.refreshToken })).status).toBe(401);
      const me = await api.req('get', '/auth/me', t2.accessToken);
      expect(me.status).toBe(401);
      expect(me.body.error.code).toBe('SESSION_ENDED');
      const audit = await api.prisma.auditLog.findFirst({ where: { action: 'AUTH_REFRESH_REUSE_DETECTED' } });
      expect(audit).not.toBeNull();
    });

    it('rejects unknown refresh tokens', async () => {
      const res = await api.req('post', '/auth/refresh').send({ refreshToken: 'x'.repeat(64) });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('logout revokes the session immediately (access token included)', async () => {
      const t = await signIn(api, 'owner@alpha.test');
      expect((await api.req('post', '/auth/logout', t.accessToken)).status).toBe(204);
      expect((await api.req('get', '/auth/me', t.accessToken)).body.error.code).toBe('SESSION_ENDED');
      expect((await api.req('post', '/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
    });
  });

  describe('change password', () => {
    it('requires the current password, enforces strength, and ends all sessions', async () => {
      await createUser(api, (await signIn(api, 'owner@alpha.test')).accessToken, 'pw@alpha.test', 'VIEWER');
      const t = await signIn(api, 'pw@alpha.test');

      const bad = await api.req('post', '/auth/change-password', t.accessToken)
        .send({ currentPassword: 'nope', newPassword: 'Another-Pass-77' });
      expect(bad.status).toBe(401);
      const weak = await api.req('post', '/auth/change-password', t.accessToken)
        .send({ currentPassword: PASSWORD, newPassword: 'short' });
      expect(weak.status).toBe(400);
      const same = await api.req('post', '/auth/change-password', t.accessToken)
        .send({ currentPassword: PASSWORD, newPassword: PASSWORD });
      expect(same.body.error.code).toBe('PASSWORD_UNCHANGED');

      const ok = await api.req('post', '/auth/change-password', t.accessToken)
        .send({ currentPassword: PASSWORD, newPassword: 'Another-Pass-77' });
      expect(ok.status).toBe(204);
      expect((await api.req('get', '/auth/me', t.accessToken)).status).toBe(401);
      expect((await login(api, 'pw@alpha.test')).status).toBe(401);
      expect((await login(api, 'pw@alpha.test', undefined, 'Another-Pass-77')).status).toBe(200);
    });
  });

  describe('tenant membership', () => {
    it('lets a multi-office user pick an office and switch between them', async () => {
      await provision(api, 'beta', 'owner@beta.test');
      // the alpha owner also becomes a member of beta
      const betaOwner = await signIn(api, 'owner@beta.test');
      await createUser(api, betaOwner.accessToken, 'owner@alpha.test', 'MANAGER');

      const sel = await login(api, 'owner@alpha.test');
      expect(sel.status).toBe(200);
      expect(sel.body.data.tenantSelectionRequired).toBe(true);
      expect(sel.body.data.tenants.map((t: any) => t.slug).sort()).toEqual(['alpha', 'beta']);
      expect(sel.body.data.accessToken).toBeUndefined();

      const inBeta = await signIn(api, 'owner@alpha.test', 'beta');
      const me = await api.req('get', '/auth/me', inBeta.accessToken);
      expect(me.body.data.tenant.slug).toBe('beta');
      expect(me.body.data.roles.map((r: any) => r.code)).toEqual(['MANAGER']); // permissions are per office

      const sw = await api.req('post', '/auth/switch-tenant', inBeta.accessToken).send({ tenantSlug: 'alpha' });
      expect(sw.status).toBe(200);
      const me2 = await api.req('get', '/auth/me', sw.body.data.accessToken);
      expect(me2.body.data.tenant.slug).toBe('alpha');
      expect(me2.body.data.roles.map((r: any) => r.code)).toEqual(['OWNER']);
    });

    it('refuses to switch to or log in to an office the user does not belong to', async () => {
      await provision(api, 'gamma', 'owner@gamma.test');
      const t = await signIn(api, 'pw@alpha.test'.replace('pw', 'owner'), 'alpha');
      expect((await api.req('post', '/auth/switch-tenant', t.accessToken).send({ tenantSlug: 'gamma' })).status).toBe(403);
      const res = await login(api, 'owner@gamma.test', 'alpha');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('TENANT_ACCESS_DENIED');
    });

    it('does not trust the tenant id inside a token: a forged tid without membership is rejected', async () => {
      const beta = await api.prisma.tenant.findUniqueOrThrow({ where: { slug: 'gamma' } });
      const user = await api.prisma.user.findUniqueOrThrow({ where: { email: 'owner@alpha.test' } });
      const t = await signIn(api, 'owner@alpha.test', 'alpha');
      const family = (await api.prisma.refreshSession.findFirstOrThrow({ where: { userId: user.id, revokedAt: null } })).familyId;
      // Even with a validly SIGNED token (worst case: signing key leaked), membership is re-checked.
      const forged = new JwtService().sign(
        { sub: user.id, tid: beta.id, sid: family },
        { secret: JWT_SECRET, issuer: 'clearport', audience: 'clearport-api', expiresIn: 300 },
      );
      const res = await api.req('get', '/tenant', forged);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('ACCESS_REVOKED');
      expect(t.accessToken).toBeDefined();
    });
  });
});

describe('rate limiting', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startApi({ RATE_LIMIT_AUTH: '3' });
    await provision(api, 'rl', 'owner@rl.test');
  });
  afterAll(async () => api.close());

  it('throttles repeated credential attempts per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await login(api, 'owner@rl.test', undefined, 'Wrong-Password-1')).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    const blocked = await login(api, 'owner@rl.test');
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
  });
});
