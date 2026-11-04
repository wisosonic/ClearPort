import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';

describe('CRM API: clients, contacts, parties', () => {
  let api: TestApi;
  let A: string; // owner token, office A
  let B: string; // owner token, office B
  let viewer: string;
  let officer: string;
  let manager: string;
  let accountant: string;

  const newClient = (token: string, body: Record<string, unknown>) =>
    api.req('post', '/clients', token).send({ name: 'Acme Trading', ...body });

  beforeAll(async () => {
    api = await startApi();
    await provision(api, 'crm-a', 'owner@crm-a.test');
    await provision(api, 'crm-b', 'owner@crm-b.test');
    A = (await signIn(api, 'owner@crm-a.test')).accessToken;
    B = (await signIn(api, 'owner@crm-b.test')).accessToken;
    for (const [email, role] of [
      ['viewer@crm-a.test', 'VIEWER'], ['officer@crm-a.test', 'CLEARANCE_OFFICER'],
      ['manager@crm-a.test', 'MANAGER'], ['acct@crm-a.test', 'ACCOUNTANT'],
    ] as const) await createUser(api, A, email, role);
    viewer = (await signIn(api, 'viewer@crm-a.test')).accessToken;
    officer = (await signIn(api, 'officer@crm-a.test')).accessToken;
    manager = (await signIn(api, 'manager@crm-a.test')).accessToken;
    accountant = (await signIn(api, 'acct@crm-a.test')).accessToken;
  });
  afterAll(async () => api.close());

  describe('creating and validating clients', () => {
    it('generates sequential client codes per office', async () => {
      const c1 = await newClient(A, { name: 'First' });
      const c2 = await newClient(A, { name: 'Second' });
      expect(c1.status).toBe(201);
      expect(c1.body.data.clientCode).toBe('CLT-00001');
      expect(c2.body.data.clientCode).toBe('CLT-00002');
      expect((await newClient(B, { name: 'Other office' })).body.data.clientCode).toBe('CLT-00001'); // independent per tenant
    });

    it('accepts a manual code, upper-cases it, and rejects duplicates within the office only', async () => {
      const ok = await newClient(A, { clientCode: 'abc-1', name: 'Manual' });
      expect(ok.body.data.clientCode).toBe('ABC-1');
      const dup = await newClient(A, { clientCode: 'ABC-1', name: 'Dup' });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('CLIENT_CODE_TAKEN');
      expect((await newClient(B, { clientCode: 'ABC-1', name: 'Same code, other office' })).status).toBe(201);
    });

    it('skips auto codes that were already typed by hand', async () => {
      await newClient(B, { clientCode: 'CLT-00002', name: 'Hand-typed' });
      const auto = await newClient(B, { name: 'Auto' });
      expect(auto.body.data.clientCode).toBe('CLT-00003');
    });

    it('normalises input: trims, upper-cases country, clears empty strings, formats money', async () => {
      const res = await newClient(A, {
        name: '  Padded Name  ', countryCode: 'lb', phone: '', email: 'INFO@Acme.COM',
        creditLimit: '5000', paymentTermsDays: 30, notes: '   ',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        name: 'Padded Name', countryCode: 'LB', phone: null, email: 'info@acme.com',
        creditLimit: '5000.0000', paymentTermsDays: 30, notes: null, isActive: true, clientType: 'COMPANY',
      });
    });

    it('rejects invalid input with field-level errors', async () => {
      const bad = await newClient(A, { name: '', email: 'nope', countryCode: 'LBN', creditLimit: '-5', paymentTermsDays: 9999 });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_ERROR');
      expect(bad.body.error.details.map((d: any) => d.path).sort()).toEqual(
        ['countryCode', 'creditLimit', 'email', 'name', 'paymentTermsDays'],
      );
      expect((await newClient(A, { creditLimit: '1.23456' })).status).toBe(400); // max 4 decimals
      expect((await newClient(A, { clientCode: 'has space' })).status).toBe(400);
    });

    it('ignores a tenantId smuggled into the body', async () => {
      const bTenant = await api.prisma.tenant.findUniqueOrThrow({ where: { slug: 'crm-b' } });
      const res = await newClient(A, { name: 'Smuggler', tenantId: bTenant.id });
      expect(res.status).toBe(201);
      const row = await api.prisma.client.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(row.tenantId).not.toBe(bTenant.id);
    });

    it('keeps the client code immutable and updates other fields', async () => {
      const c = (await newClient(A, { name: 'To edit' })).body.data;
      expect((await api.req('patch', `/clients/${c.id}`, A).send({ clientCode: 'NEW-CODE' })).status).toBe(400);
      const upd = await api.req('patch', `/clients/${c.id}`, A).send({ name: 'Edited', creditLimit: null, taxNumber: 'TX-9' });
      expect(upd.status).toBe(200);
      expect(upd.body.data).toMatchObject({ name: 'Edited', creditLimit: null, taxNumber: 'TX-9', clientCode: c.clientCode });
      const off = await api.req('patch', `/clients/${c.id}`, A).send({ isActive: false });
      expect(off.body.data.isActive).toBe(false);
      const logs = await api.prisma.auditLog.findMany({ where: { entityId: c.id } });
      expect(logs.map((l) => l.action).sort()).toEqual(['CLIENT_CREATED', 'CLIENT_DEACTIVATED', 'CLIENT_UPDATED']);
    });

    it('returns 404 with a code for an unknown client and 400 for a malformed id', async () => {
      const missing = await api.req('get', '/clients/00000000-0000-4000-8000-000000000000', A);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('CLIENT_NOT_FOUND');
      expect((await api.req('get', '/clients/not-a-uuid', A)).status).toBe(400);
    });
  });

  describe('contacts', () => {
    let clientId: string;
    beforeAll(async () => {
      clientId = (await newClient(A, {
        name: 'With contacts',
        contacts: [{ name: 'Ann', email: 'ann@x.test' }, { name: 'Bob', isPrimary: true }, { name: 'Cy' }],
      })).body.data.id;
    });

    const contacts = async () => (await api.req('get', `/clients/${clientId}`, A)).body.data.contacts as any[];

    it('keeps exactly one primary contact when several are supplied', async () => {
      const list = await contacts();
      expect(list).toHaveLength(3);
      expect(list.filter((c) => c.isPrimary).map((c) => c.name)).toEqual(['Bob']);
    });

    it('moves the primary flag when another contact becomes primary', async () => {
      const cy = (await contacts()).find((c) => c.name === 'Cy');
      await api.req('patch', `/clients/${clientId}/contacts/${cy.id}`, A).send({ isPrimary: true });
      expect((await contacts()).filter((c) => c.isPrimary).map((c) => c.name)).toEqual(['Cy']);
    });

    it('promotes another contact when the primary is deleted, and never leaves none', async () => {
      const cy = (await contacts()).find((c) => c.name === 'Cy');
      expect((await api.req('delete', `/clients/${clientId}/contacts/${cy.id}`, A)).status).toBe(204);
      const after = await contacts();
      expect(after).toHaveLength(2);
      expect(after.filter((c) => c.isPrimary)).toHaveLength(1);
      // un-flagging the only primary re-promotes one
      const primary = after.find((c) => c.isPrimary);
      await api.req('patch', `/clients/${clientId}/contacts/${primary.id}`, A).send({ isPrimary: false });
      expect((await contacts()).filter((c) => c.isPrimary)).toHaveLength(1);
    });

    it('makes the first added contact primary automatically', async () => {
      const fresh = (await newClient(A, { name: 'No contacts yet' })).body.data.id;
      const c = await api.req('post', `/clients/${fresh}/contacts`, A).send({ name: 'Only one' });
      expect(c.status).toBe(201);
      expect(c.body.data.isPrimary).toBe(true);
    });

    it('does not let a contact be reached through the wrong client', async () => {
      const other = (await newClient(A, { name: 'Other client' })).body.data.id;
      const any = (await contacts())[0];
      expect((await api.req('patch', `/clients/${other}/contacts/${any.id}`, A).send({ name: 'x' })).status).toBe(404);
      expect((await api.req('delete', `/clients/${other}/contacts/${any.id}`, A)).status).toBe(404);
    });
  });

  describe('searching, filtering and paging', () => {
    beforeAll(async () => {
      for (let i = 1; i <= 25; i++) {
        await newClient(A, {
          clientCode: `SRCH-${String(i).padStart(2, '0')}`, name: `Search Corp ${String(i).padStart(2, '0')}`,
          taxNumber: i === 7 ? 'VAT-777' : undefined, phone: i === 8 ? '+961 3 123456' : undefined,
          countryCode: i % 2 === 0 ? 'LB' : 'TR', clientType: i % 5 === 0 ? 'INDIVIDUAL' : 'COMPANY',
        });
      }
    });

    it('paginates on the server and reports totals in meta', async () => {
      const p1 = await api.req('get', '/clients?search=Search Corp&limit=10&page=1&sort=name:asc', A);
      expect(p1.body.data).toHaveLength(10);
      expect(p1.body.meta).toEqual({ page: 1, limit: 10, total: 25 });
      expect(p1.body.data[0].name).toBe('Search Corp 01');
      const p3 = await api.req('get', '/clients?search=Search Corp&limit=10&page=3&sort=name:asc', A);
      expect(p3.body.data).toHaveLength(5);
      expect(p3.body.data[4].name).toBe('Search Corp 25');
    });

    it('searches by name, code, tax number and phone', async () => {
      const byTax = await api.req('get', '/clients?search=VAT-777', A);
      expect(byTax.body.data.map((c: any) => c.clientCode)).toEqual(['SRCH-07']);
      const byPhone = await api.req('get', '/clients?search=123456', A);
      expect(byPhone.body.data.map((c: any) => c.clientCode)).toEqual(['SRCH-08']);
      const byCode = await api.req('get', '/clients?search=SRCH-2', A);
      expect(byCode.body.meta.total).toBe(6); // SRCH-20 .. SRCH-25
    });

    it('filters by type, country and active state', async () => {
      const ind = await api.req('get', '/clients?search=Search Corp&clientType=INDIVIDUAL&limit=100', A);
      expect(ind.body.meta.total).toBe(5);
      const lb = await api.req('get', '/clients?search=Search Corp&countryCode=lb&limit=100', A);
      expect(lb.body.meta.total).toBe(12);
      const inactive = await api.req('get', '/clients?isActive=false', A);
      expect(inactive.body.data.every((c: any) => c.isActive === false)).toBe(true);
    });

    it('only sorts by allow-listed fields and caps the page size', async () => {
      const bad = await api.req('get', '/clients?sort=passwordHash:asc&limit=5', A);
      expect(bad.status).toBe(200); // unknown sort field falls back to the default order
      expect((await api.req('get', '/clients?limit=1000', A)).status).toBe(400);
      expect((await api.req('get', '/clients?page=0', A)).status).toBe(400);
    });

    it('treats LIKE wildcards in search as plain text and is injection-safe', async () => {
      const wild = await api.req('get', `/clients?search=${encodeURIComponent("'; DROP TABLE clients; --")}`, A);
      expect(wild.status).toBe(200);
      expect(wild.body.data).toEqual([]);
      expect((await api.req('get', '/clients?limit=1', A)).body.meta.total).toBeGreaterThan(25); // table intact
    });

    it('does not let % or _ in a search act as wildcards', async () => {
      for (const s of ['%', '_', 'Search_Corp', '%25']) {
        const res = await api.req('get', `/clients?search=${encodeURIComponent(s)}&limit=100`, A);
        expect(res.status).toBe(200);
        expect(res.body.meta.total, `search "${s}"`).toBe(0);
      }
    });
  });

  describe('permissions', () => {
    it('lets read-only roles view but not change clients', async () => {
      for (const t of [viewer, officer, accountant]) {
        expect((await api.req('get', '/clients', t)).status).toBe(200);
        const create = await newClient(t, { name: 'Nope' });
        expect(create.status).toBe(403);
        expect(create.body.error.code).toBe('PERMISSION_DENIED');
      }
      expect((await newClient(manager, { name: 'By manager' })).status).toBe(201);
    });

    it('requires the matching view permissions for files, balance and statement', async () => {
      const id = (await newClient(A, { name: 'Perm check' })).body.data.id;
      expect((await api.req('get', `/clients/${id}/files`, viewer)).status).toBe(200);
      expect((await api.req('get', `/clients/${id}/balance`, viewer)).status).toBe(200);
      expect((await api.req('get', `/clients/${id}/balance`, accountant)).status).toBe(200);
      const noFin = await createRoleUser('NO_FIN', ['clients.view', 'clearance_files.view'], 'nofin@crm-a.test');
      expect((await api.req('get', `/clients/${id}/files`, noFin)).status).toBe(200);
      expect((await api.req('get', `/clients/${id}/balance`, noFin)).status).toBe(403);
      expect((await api.req('get', `/clients/${id}/statement`, noFin)).status).toBe(403);
    });

    async function createRoleUser(code: string, perms: string[], email: string) {
      const role = await api.req('post', '/roles', A).send({ code, name: code, permissionCodes: perms });
      await api.req('post', '/users', A).send({
        email, firstName: 'N', lastName: 'F', password: 'Correct-Horse-9', roleIds: [role.body.data.id],
      });
      return (await signIn(api, email)).accessToken;
    }
  });

  describe('office isolation', () => {
    let bClient: { id: string };
    let bContact: { id: string };
    let bParty: { id: string };

    beforeAll(async () => {
      bClient = (await newClient(B, { name: 'Secret client of B', contacts: [{ name: 'B contact' }] })).body.data;
      bContact = (await api.req('get', `/clients/${bClient.id}`, B)).body.data.contacts[0];
      bParty = (await api.req('post', '/parties', B).send({ name: 'B shipping', partyType: 'SHIPPING_AGENT' })).body.data;
    });

    it('never lists, searches or counts another office\'s clients', async () => {
      const res = await api.req('get', '/clients?search=Secret&limit=100', A);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });

    it('answers 404 for every client route on a foreign id', async () => {
      const calls: [Parameters<TestApi['req']>[0], string, object?][] = [
        ['get', `/clients/${bClient.id}`],
        ['patch', `/clients/${bClient.id}`, { name: 'hacked' }],
        ['get', `/clients/${bClient.id}/files`],
        ['get', `/clients/${bClient.id}/balance`],
        ['get', `/clients/${bClient.id}/statement`],
        ['post', `/clients/${bClient.id}/contacts`, { name: 'planted' }],
        ['patch', `/clients/${bClient.id}/contacts/${bContact.id}`, { name: 'hacked' }],
        ['delete', `/clients/${bClient.id}/contacts/${bContact.id}`],
      ];
      for (const [method, path, body] of calls) {
        const res = await api.req(method, path, A).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      const intact = (await api.req('get', `/clients/${bClient.id}`, B)).body.data;
      expect(intact.name).toBe('Secret client of B');
      expect(intact.contacts).toHaveLength(1);
      expect(intact.contacts[0].name).toBe('B contact');
    });

    it('isolates business parties the same way', async () => {
      expect((await api.req('get', `/parties/${bParty.id}`, A)).status).toBe(404);
      expect((await api.req('patch', `/parties/${bParty.id}`, A).send({ name: 'hacked' })).status).toBe(404);
      expect((await api.req('get', '/parties?search=B shipping', A)).body.data).toEqual([]);
    });
  });

  describe('business parties', () => {
    it('creates, filters and updates parties, independent of clients', async () => {
      const agent = await api.req('post', '/parties', A).send({
        name: 'Med Shipping Agency', partyType: 'SHIPPING_AGENT', countryCode: 'lb', email: 'ops@med.test',
      });
      expect(agent.status).toBe(201);
      expect(agent.body.data.countryCode).toBe('LB');
      await api.req('post', '/parties', A).send({ name: 'Fast Forwarders', partyType: 'FREIGHT_FORWARDER' });
      // the same company can also be a client: nothing links or conflicts
      await newClient(A, { name: 'Med Shipping Agency' });

      const agents = await api.req('get', '/parties?partyType=SHIPPING_AGENT', A);
      expect(agents.body.data.map((p: any) => p.name)).toEqual(['Med Shipping Agency']);
      const search = await api.req('get', '/parties?search=forward', A);
      expect(search.body.data.map((p: any) => p.name)).toEqual(['Fast Forwarders']);

      const upd = await api.req('patch', `/parties/${agent.body.data.id}`, A).send({ partyType: 'SUPPLIER', phone: '+961 1 555' });
      expect(upd.body.data).toMatchObject({ partyType: 'SUPPLIER', phone: '+961 1 555' });
    });

    it('validates the party type and requires manage permission to change', async () => {
      expect((await api.req('post', '/parties', A).send({ name: 'X', partyType: 'WIZARD' })).status).toBe(400);
      expect((await api.req('post', '/parties', viewer).send({ name: 'X', partyType: 'OTHER' })).status).toBe(403);
      expect((await api.req('get', '/parties', viewer)).status).toBe(200);
    });
  });
});
