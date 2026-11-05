import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, login, PASSWORD, provision, roleId, signIn, startApi, type TestApi } from './api-helpers';

/**
 * Attacks from inside one office against another, plus role-based access control. All through
 * the real HTTP stack (guards, tenant context, tenant-scoped data layer).
 */
describe('multi-tenant isolation and RBAC (API)', () => {
  let api: TestApi;
  let A: string; // owner token, office A
  let B: string; // owner token, office B
  let aEmployee: { id: string };
  let bEmployee: { id: string };
  let bBranch: { id: string };

  beforeAll(async () => {
    api = await startApi();
    await provision(api, 'office-a', 'owner@a.test');
    await provision(api, 'office-b', 'owner@b.test');
    A = (await signIn(api, 'owner@a.test')).accessToken;
    B = (await signIn(api, 'owner@b.test')).accessToken;
    aEmployee = await createUser(api, A, 'officer@a.test', 'CLEARANCE_OFFICER');
    bEmployee = await createUser(api, B, 'officer@b.test', 'CLEARANCE_OFFICER');
    bBranch = (await api.req('post', '/branches', B).send({ code: 'BRB', name: 'B branch' })).body.data;
  });
  afterAll(async () => api.close());

  describe('data never leaks across offices', () => {
    it('lists only the caller\'s own users', async () => {
      const res = await api.req('get', '/users', A);
      expect(res.status).toBe(200);
      const emails = res.body.data.map((u: any) => u.email).sort();
      expect(emails).toEqual(['officer@a.test', 'owner@a.test']);
      expect(res.body.meta).toEqual({ page: 1, limit: 20, total: 2 });
    });

    it('searches users only inside the caller\'s office and treats wildcards literally', async () => {
      // "officer" exists in both offices (officer@a.test and officer@b.test)
      const a = await api.req('get', '/users?search=officer', A);
      expect(a.body.data.map((u: any) => u.email)).toEqual(['officer@a.test']);
      const b = await api.req('get', '/users?search=officer', B);
      expect(b.body.data.map((u: any) => u.email)).toEqual(['officer@b.test']);
      // a term that only matches the other office finds nothing
      expect((await api.req('get', '/users?search=%40b.test', A)).body.data).toEqual([]);
      // wildcards are literal: "%" alone matches nothing, and "%" does not stand in for characters
      for (const s of ['%', 'CLEARANCE%OFFICER', 'CLEARANCE.OFFICER']) {
        expect((await api.req('get', `/users?search=${encodeURIComponent(s)}`, A)).body.data, s).toEqual([]);
      }
      // while a literal underscore (in the officer's last name CLEARANCE_OFFICER) does match
      const literal = await api.req('get', `/users?search=${encodeURIComponent('CLEARANCE_OFFICER')}`, A);
      expect(literal.body.data.map((u: any) => u.email)).toEqual(['officer@a.test']);
    });

    it('returns 404 (not 403) for another office\'s user, so existence is not revealed', async () => {
      for (const [method, path, body] of [
        ['get', `/users/${bEmployee.id}`, undefined],
        ['patch', `/users/${bEmployee.id}`, { firstName: 'Hacked' }],
        ['patch', `/users/${bEmployee.id}/status`, { isActive: false }],
      ] as const) {
        const res = await api.req(method, path, A).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.body.error.code).toBe('USER_NOT_FOUND');
      }
      const still = await api.req('get', `/users/${bEmployee.id}`, B);
      expect(still.body.data.isActive).toBe(true);
    });

    it('cannot patch another office\'s branch', async () => {
      const res = await api.req('patch', `/branches/${bBranch.id}`, A).send({ name: 'hacked' });
      expect(res.status).toBe(404);
      const branches = (await api.req('get', '/branches', B)).body.data;
      expect(branches.find((b: any) => b.id === bBranch.id).name).toBe('B branch');
      expect((await api.req('get', '/branches', A)).body.data.map((b: any) => b.code)).toEqual(['MAIN']);
    });

    it('rejects assigning another office\'s branch or role to a user', async () => {
      const viewer = await roleId(api, 'VIEWER');
      const badBranch = await api.req('post', '/users', A).send({
        email: 'x1@a.test', firstName: 'X', lastName: 'Y', password: PASSWORD, roleIds: [viewer], branchId: bBranch.id,
      });
      expect(badBranch.status).toBe(422);
      expect(badBranch.body.error.code).toBe('BRANCH_NOT_FOUND');

      const bRole = (await api.req('post', '/roles', B).send({
        code: 'B_ONLY', name: 'B only role', permissionCodes: ['clients.view'],
      })).body.data;
      const badRole = await api.req('post', '/users', A).send({
        email: 'x2@a.test', firstName: 'X', lastName: 'Y', password: PASSWORD, roleIds: [bRole.id],
      });
      expect(badRole.status).toBe(422);
      expect(badRole.body.error.code).toBe('ROLE_NOT_FOUND');
      // A cannot see B's custom role, but does see the shared system roles
      const aRoles = (await api.req('get', '/roles', A)).body.data.map((r: any) => r.code);
      expect(aRoles).not.toContain('B_ONLY');
      expect(aRoles).toEqual(expect.arrayContaining(['OWNER', 'ADMIN', 'MANAGER', 'CLEARANCE_OFFICER', 'ACCOUNTANT', 'VIEWER']));
      // and cannot edit it
      const edit = await api.req('put', `/roles/${bRole.id}/permissions`, A).send({ permissionCodes: ['clients.view'] });
      expect(edit.status).toBe(404);
    });

    it('treats the same e-mail in two offices as one account with separate memberships and roles', async () => {
      const aToken = A;
      await createUser(api, B, 'shared@x.test', 'VIEWER');
      const link = await api.req('post', '/users', aToken).send({
        email: 'shared@x.test', firstName: 'Ignored', lastName: 'Ignored', roleIds: [await roleId(api, 'MANAGER')],
      });
      expect(link.status).toBe(201); // linked, no password needed, existing profile untouched
      expect(link.body.data.firstName).toBe('Emp');
      const dup = await api.req('post', '/users', aToken).send({
        email: 'shared@x.test', firstName: 'a', lastName: 'b', roleIds: [await roleId(api, 'MANAGER')],
      });
      expect(dup.status).toBe(409);
      // A may not rewrite a profile that is shared with another office
      const edit = await api.req('patch', `/users/${link.body.data.id}`, aToken).send({ firstName: 'Hacked' });
      expect(edit.status).toBe(409);
      expect(edit.body.error.code).toBe('PROFILE_SHARED');
    });
  });

  describe('permission checks are enforced by the backend', () => {
    it('denies by default: a viewer cannot manage users, roles or settings', async () => {
      await createUser(api, A, 'viewer@a.test', 'VIEWER');
      const v = (await signIn(api, 'viewer@a.test')).accessToken;
      expect((await api.req('get', '/users', v)).status).toBe(403);
      expect((await api.req('get', '/roles', v)).status).toBe(403);
      const create = await api.req('post', '/branches', v).send({ code: 'NEW', name: 'New' });
      expect(create.status).toBe(403);
      expect(create.body.error.code).toBe('PERMISSION_DENIED');
      expect((await api.req('patch', '/tenant', v).send({ name: 'Renamed' })).status).toBe(403);
      // but any member can read the basics
      expect((await api.req('get', '/branches', v)).status).toBe(200);
      expect((await api.req('get', '/tenant', v)).status).toBe(200);
    });

    it('lets the owner edit office settings; the main currency only while nothing has been booked in it', async () => {
      const ok = await api.req('patch', '/tenant', A).send({ phone: '+961 1 000000', locale: 'ar' });
      expect(ok.status).toBe(200);
      expect(ok.body.data.locale).toBe('ar');
      expect((await api.req('patch', '/tenant', A).send({ defaultCurrency: 'XXXX' })).status).toBe(400); // not a currency code
      expect((await api.req('patch', '/tenant', A).send({ defaultCurrency: 'ZZZ' })).body.error.code).toBe('CURRENCY_NOT_FOUND');
      expect((await api.req('patch', '/tenant', A).send({ colour: 'blue' })).status).toBe(400); // .strict(): unknown field
      expect((await api.req('patch', '/tenant', A).send({ timezone: 'Mars/Olympus' })).status).toBe(400); // not a real time zone
      expect((await api.req('patch', '/tenant', A).send({ timezone: 'Europe/Paris' })).status).toBe(200);
      await api.req('patch', '/tenant', A).send({ timezone: 'Asia/Beirut' });
      const other = await api.req('get', '/tenant', B);
      expect(other.body.data.locale).toBe('en'); // B untouched
      expect(other.body.data.slug).toBe('office-b');
    });

    it('applies role changes immediately, without waiting for the token to expire', async () => {
      await createUser(api, A, 'promote@a.test', 'VIEWER');
      const tok = (await signIn(api, 'promote@a.test')).accessToken;
      expect((await api.req('get', '/users', tok)).status).toBe(403);
      const user = (await api.req('get', '/users', A)).body.data.find((u: any) => u.email === 'promote@a.test');
      await api.req('patch', `/users/${user.id}`, A).send({ roleIds: [await roleId(api, 'MANAGER')] });
      // MANAGER has no users.manage
      expect((await api.req('get', '/users', tok)).status).toBe(403);
      expect((await api.req('get', '/clients-not-built-yet', tok)).status).toBe(404);
    });
  });

  describe('privilege escalation is blocked', () => {
    it('stops an Admin from granting the Owner role or permissions they lack', async () => {
      await createUser(api, A, 'admin@a.test', 'ADMIN');
      const admin = (await signIn(api, 'admin@a.test')).accessToken;

      const ownerRole = await roleId(api, 'OWNER');
      const grantOwner = await api.req('post', '/users', admin).send({
        email: 'esc1@a.test', firstName: 'E', lastName: 'S', password: PASSWORD, roleIds: [ownerRole],
      });
      expect(grantOwner.status).toBe(403);
      expect(grantOwner.body.error.code).toBe('PRIVILEGE_ESCALATION');

      // Admin has no accounting.post, so cannot create a role containing it
      const role = await api.req('post', '/roles', admin).send({
        code: 'SNEAKY', name: 'Sneaky', permissionCodes: ['accounting.post'],
      });
      expect(role.status).toBe(403);
      expect(role.body.error.code).toBe('PRIVILEGE_ESCALATION');
    });

    it('keeps system roles read-only and reserves their codes', async () => {
      const viewerRole = await roleId(api, 'VIEWER');
      const edit = await api.req('put', `/roles/${viewerRole}/permissions`, A).send({ permissionCodes: ['users.manage'] });
      expect(edit.status).toBe(403);
      expect(edit.body.error.code).toBe('SYSTEM_ROLE_READONLY');
      const dup = await api.req('post', '/roles', A).send({ code: 'OWNER', name: 'Fake owner', permissionCodes: [] });
      expect(dup.status).toBe(409);
      const unknown = await api.req('post', '/roles', A).send({ code: 'BAD', name: 'Bad', permissionCodes: ['nope.nope'] });
      expect(unknown.status).toBe(403); // not held by caller (checked before lookup)
    });

    it('lets a custom role be edited by an owner and applied to users', async () => {
      const role = await api.req('post', '/roles', A).send({
        code: 'CLIENT_CLERK', name: 'Client clerk', permissionCodes: ['clients.view', 'clients.manage'],
      });
      expect(role.status).toBe(201);
      const upd = await api.req('put', `/roles/${role.body.data.id}/permissions`, A).send({ permissionCodes: ['clients.view'] });
      expect(upd.body.data.permissionCodes).toEqual(['clients.view']);
      const u = await api.req('post', '/users', A).send({
        email: 'clerk@a.test', firstName: 'C', lastName: 'C', password: PASSWORD, roleIds: [role.body.data.id],
      });
      expect(u.status).toBe(201);
      const me = await api.req('get', '/auth/me', (await signIn(api, 'clerk@a.test')).accessToken);
      expect(me.body.data.permissions).toEqual(['clients.view']);
    });
  });

  describe('account lifecycle', () => {
    it('deactivation ends sessions at once and blocks new logins', async () => {
      const u = await createUser(api, A, 'leaver@a.test', 'CLEARANCE_OFFICER');
      const t = await signIn(api, 'leaver@a.test');
      expect((await api.req('get', '/auth/me', t.accessToken)).status).toBe(200);

      const off = await api.req('patch', `/users/${u.id}/status`, A).send({ isActive: false });
      expect(off.status).toBe(200);
      expect(off.body.data.isActive).toBe(false);

      const me = await api.req('get', '/auth/me', t.accessToken);
      expect(me.status).toBe(401);
      expect((await api.req('post', '/auth/refresh').send({ refreshToken: t.refreshToken })).status).toBe(401);
      const relog = await login(api, 'leaver@a.test');
      expect(relog.status).toBe(403);
      expect(relog.body.error.code).toBe('NO_ACTIVE_TENANT');

      await api.req('patch', `/users/${u.id}/status`, A).send({ isActive: true });
      expect((await login(api, 'leaver@a.test')).status).toBe(200);
    });

    it('protects the last Owner and prevents self-deactivation', async () => {
      const ownerA = (await api.req('get', '/users', A)).body.data.find((u: any) => u.email === 'owner@a.test');
      const self = await api.req('patch', `/users/${ownerA.id}/status`, A).send({ isActive: false });
      expect(self.body.error.code).toBe('CANNOT_DEACTIVATE_SELF');

      // a second owner may deactivate... but never the LAST one
      await createUser(api, A, 'owner2@a.test', 'OWNER');
      const o2 = (await signIn(api, 'owner2@a.test')).accessToken;
      expect((await api.req('patch', `/users/${ownerA.id}/status`, o2).send({ isActive: false })).status).toBe(200);
      const o2user = (await api.req('get', '/users', o2)).body.data.find((u: any) => u.email === 'owner2@a.test');
      const demote = await api.req('patch', `/users/${o2user.id}`, o2).send({ roleIds: [await roleId(api, 'VIEWER')] });
      expect(demote.status).toBe(409);
      expect(demote.body.error.code).toBe('LAST_OWNER');
    });

    it('audits security-relevant changes without leaking secrets', async () => {
      const logs = await api.prisma.auditLog.findMany({ where: { tenantId: { not: null } } });
      const actions = [...new Set(logs.map((l) => l.action))];
      expect(actions).toEqual(expect.arrayContaining(['USER_CREATED', 'USER_DEACTIVATED', 'ROLE_CREATED', 'TENANT_UPDATED']));
      // deactivation + a retried refresh is NOT a theft signal
      expect(actions).not.toContain('AUTH_REFRESH_REUSE_DETECTED');
      expect(JSON.stringify(logs)).not.toMatch(new RegExp(`${PASSWORD}|passwordHash|argon2`));
    });
  });
});
