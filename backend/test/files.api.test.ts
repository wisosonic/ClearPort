import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iso6346CheckDigit } from '../src/common/iso6346';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';

const YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric' }).format(new Date());
/** A valid ISO 6346 number from its first 10 characters. */
const cn = (first10: string) => `${first10}${iso6346CheckDigit(first10)}`;

describe('clearance files API', () => {
  let api: TestApi;
  let A: string; // owner A
  let B: string; // owner B
  let officer: string;
  let manager: string;
  let viewer: string;
  let ids: { clientA: string; clientB: string; officerUser: string; managerUser: string; ownerA: string; clientAInactive: string };
  let tenantAId: string;

  const mkFile = (token: string, body: Record<string, unknown> = {}) =>
    api.req('post', '/clearance-files', token).send({ fileType: 'IMPORT', clientId: ids.clientA, ...body });
  const ok = async (p: Promise<any> | any) => {
    const res = await p;
    if (res.status >= 300) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };

  beforeAll(async () => {
    api = await startApi();
    const a = await provision(api, 'files-a', 'owner@files-a.test');
    await provision(api, 'files-b', 'owner@files-b.test');
    tenantAId = a.tenantId;
    A = (await signIn(api, 'owner@files-a.test')).accessToken;
    B = (await signIn(api, 'owner@files-b.test')).accessToken;
    const officerUser = await createUser(api, A, 'officer@files-a.test', 'CLEARANCE_OFFICER');
    const managerUser = await createUser(api, A, 'manager@files-a.test', 'MANAGER');
    await createUser(api, A, 'viewer@files-a.test', 'VIEWER');
    officer = (await signIn(api, 'officer@files-a.test')).accessToken;
    manager = (await signIn(api, 'manager@files-a.test')).accessToken;
    viewer = (await signIn(api, 'viewer@files-a.test')).accessToken;
    const clientA = await ok(api.req('post', '/clients', A).send({ name: 'Acme Trading' }));
    const clientAInactive = await ok(api.req('post', '/clients', A).send({ name: 'Dormant Co' }));
    await api.req('patch', `/clients/${clientAInactive.id}`, A).send({ isActive: false });
    const clientB = await ok(api.req('post', '/clients', B).send({ name: 'Beta Client' }));
    const me = await ok(api.req('get', '/auth/me', A));
    ids = {
      clientA: clientA.id, clientB: clientB.id, clientAInactive: clientAInactive.id,
      officerUser: officerUser.id, managerUser: managerUser.id, ownerA: me.user.id,
    };
  });
  afterAll(async () => api.close());

  describe('creating files', () => {
    it('generates sequential numbers per type and per office, and picks the workflow', async () => {
      const f1 = await ok(mkFile(A));
      const f2 = await ok(mkFile(A));
      const e1 = await ok(mkFile(A, { fileType: 'EXPORT' }));
      expect(f1.fileNumber).toBe(`IMP-${YEAR}-00001`);
      expect(f2.fileNumber).toBe(`IMP-${YEAR}-00002`);
      expect(e1.fileNumber).toBe(`EXP-${YEAR}-00001`);
      expect(f1).toMatchObject({ status: 'OPEN', priority: 'NORMAL', fileType: 'IMPORT', assignee: null });
      expect(f1.currentStage).toMatchObject({ code: 'NEW_FILE', nameEn: 'New file' });
      expect(f1.workflowTemplate.name).toBe('Standard import clearance');
      expect(e1.workflowTemplate.name).toBe('Standard export clearance');
      expect(f1.client).toMatchObject({ name: 'Acme Trading', clientCode: 'CLT-00001' });
      // another office has its own sequence
      const b1 = await ok(api.req('post', '/clearance-files', B).send({ fileType: 'IMPORT', clientId: ids.clientB }));
      expect(b1.fileNumber).toBe(`IMP-${YEAR}-00001`);
    });

    it('never hands out duplicate numbers under concurrent creation', async () => {
      const results = await Promise.all(Array.from({ length: 12 }, () => mkFile(A, { fileType: 'OTHER' })));
      expect(results.every((r) => r.status === 201)).toBe(true);
      const nums = results.map((r) => r.body.data.fileNumber).sort();
      expect(new Set(nums).size).toBe(12);
      expect(nums[0]).toBe(`OTH-${YEAR}-00001`);
      expect(nums[11]).toBe(`OTH-${YEAR}-00012`);
    });

    it('records the initial stage history, a timeline entry, and who created it', async () => {
      const f = await ok(mkFile(A, { internalNotes: 'first shipment', customsReference: 'DECL-001' }));
      expect(f.createdBy).toMatchObject({ firstName: 'Owner' });
      expect(f.customsReference).toBe('DECL-001');
      const history = await api.prisma.fileStatusHistory.findMany({ where: { clearanceFileId: f.id } });
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ fromStageId: null, reason: 'File created' });
      const tl = await ok(api.req('get', `/clearance-files/${f.id}/timeline`, A));
      expect(tl.map((t: any) => t.activityType)).toEqual(['FILE_CREATED']);
      expect(tl[0].user).toMatchObject({ id: ids.ownerA });
    });

    it('allows creation with only the essentials (shipment details come later)', async () => {
      const f = await ok(mkFile(A));
      expect((await ok(api.req('get', `/clearance-files/${f.id}/shipments`, A)))).toEqual([]);
      expect(f.expectedArrivalAt).toBeNull();
    });

    it('assigns at creation, logs it, and notifies the assignee (but not for self-assignment)', async () => {
      const f = await ok(mkFile(A, { assignedTo: ids.officerUser, priority: 'URGENT', expectedArrivalAt: '2026-11-15T10:00:00Z' }));
      expect(f.assignee).toMatchObject({ id: ids.officerUser });
      expect(f.priority).toBe('URGENT');
      expect(new Date(f.expectedArrivalAt).toISOString()).toBe('2026-11-15T10:00:00.000Z');
      const notes = await api.prisma.notification.findMany({ where: { userId: ids.officerUser, type: 'FILE_ASSIGNED' } });
      expect(notes.some((n) => (n.metadata as any).clearanceFileId === f.id)).toBe(true);
      const self = await ok(mkFile(A, { assignedTo: ids.ownerA }));
      expect(await api.prisma.notification.count({ where: { userId: ids.ownerA, type: 'FILE_ASSIGNED' } })).toBe(0);
      expect(self.assignee.id).toBe(ids.ownerA);
    });

    it('rejects unknown, inactive, or foreign clients, branches and assignees', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ clientId: '00000000-0000-4000-8000-000000000000' }, 'CLIENT_NOT_FOUND'],
        [{ clientId: ids.clientAInactive }, 'CLIENT_INACTIVE'],
        [{ clientId: ids.clientB }, 'CLIENT_NOT_FOUND'], // another office's client
        [{ branchId: '00000000-0000-4000-8000-000000000000' }, 'BRANCH_NOT_FOUND'],
        [{ assignedTo: '00000000-0000-4000-8000-000000000000' }, 'ASSIGNEE_NOT_FOUND'],
      ];
      for (const [extra, code] of cases) {
        const res = await mkFile(A, extra);
        expect(res.status, code).toBe(422);
        expect(res.body.error.code).toBe(code);
      }
      // an assignee from the other office
      const bOwner = (await ok(api.req('get', '/auth/me', B))).user.id;
      expect((await mkFile(A, { assignedTo: bOwner })).body.error.code).toBe('ASSIGNEE_NOT_FOUND');
      // a deactivated employee
      const gone = await createUser(api, A, 'gone@files-a.test', 'VIEWER');
      await api.req('patch', `/users/${gone.id}/status`, A).send({ isActive: false });
      expect((await mkFile(A, { assignedTo: gone.id })).body.error.code).toBe('ASSIGNEE_NOT_FOUND');
    });

    it('ignores attempts to set the number, status or stage at creation', async () => {
      const f = await ok(mkFile(A, { fileNumber: 'IMP-1999-99999', status: 'CLOSED', currentStageId: 'x', tenantId: 'x', closedAt: '2020-01-01T00:00:00Z' }));
      expect(f.fileNumber).not.toBe('IMP-1999-99999');
      expect(f.status).toBe('OPEN');
      expect(f.closedAt).toBeNull();
    });

    it('validates the input', async () => {
      const res = await api.req('post', '/clearance-files', A).send({ fileType: 'WIZARD', clientId: 'nope', priority: 'MEGA', expectedArrivalAt: 'tomorrow' });
      expect(res.status).toBe(400);
      expect(res.body.error.details.map((d: any) => d.path).sort()).toEqual(['clientId', 'expectedArrivalAt', 'fileType', 'priority']);
    });
  });

  describe('editing files', () => {
    let fileId: string;
    beforeAll(async () => { fileId = (await ok(mkFile(A))).id; });

    it('updates details and records customs-reference changes on the timeline', async () => {
      const upd = await ok(api.req('patch', `/clearance-files/${fileId}`, A).send({ priority: 'HIGH', customsReference: 'NAJIM-555' }));
      expect(upd).toMatchObject({ priority: 'HIGH', customsReference: 'NAJIM-555' });
      await api.req('patch', `/clearance-files/${fileId}`, A).send({ customsReference: 'NAJIM-556', internalNotes: 'note' });
      const tl = await ok(api.req('get', `/clearance-files/${fileId}/timeline`, A));
      const ref = tl.filter((t: any) => t.activityType === 'CUSTOMS_REFERENCE_UPDATED').map((t: any) => t.description);
      expect(ref).toEqual(['Customs reference changed from NAJIM-555 to NAJIM-556', 'Customs reference set to NAJIM-555']);
      expect(tl.some((t: any) => t.activityType === 'FILE_UPDATED' && t.description.includes('internalNotes'))).toBe(true);
    });

    it('refuses a generic status / stage / number / type / assignee change (spec 14.3)', async () => {
      for (const body of [
        { status: 'CLOSED' }, { currentStageId: '00000000-0000-4000-8000-000000000000' },
        { fileNumber: 'IMP-1-1' }, { fileType: 'EXPORT' }, { assignedTo: ids.officerUser }, { closedAt: '2026-01-01T00:00:00Z' },
      ]) {
        const res = await api.req('patch', `/clearance-files/${fileId}`, A).send(body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it('lets the client change only while no money is recorded against the file', async () => {
      const other = await ok(api.req('post', '/clients', A).send({ name: 'Second client' }));
      const moved = await ok(api.req('patch', `/clearance-files/${fileId}`, A).send({ clientId: other.id }));
      expect(moved.client.id).toBe(other.id);
      await api.prisma.invoice.create({
        data: {
          tenantId: tenantAId, clearanceFileId: fileId, clientId: other.id, invoiceNumber: 'INV-LOCK-1', currencyCode: 'USD',
          subtotal: '10.0000', totalAmount: '10.0000', createdBy: ids.ownerA,
        },
      });
      const blocked = await api.req('patch', `/clearance-files/${fileId}`, A).send({ clientId: ids.clientA });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('FILE_HAS_FINANCIAL_RECORDS');
    });

    it('treats closed and cancelled files as read-only', async () => {
      const f = await ok(mkFile(A));
      const shipment = await ok(api.req('post', `/clearance-files/${f.id}/shipments`, A).send({ vesselName: 'MV Test' }));
      await api.prisma.clearanceFile.update({ where: { id: f.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      const attempts = [
        api.req('patch', `/clearance-files/${f.id}`, A).send({ priority: 'LOW' }),
        api.req('post', `/clearance-files/${f.id}/assign`, A).send({ userId: ids.officerUser }),
        api.req('post', `/clearance-files/${f.id}/shipments`, A).send({}),
        api.req('patch', `/shipments/${shipment.id}`, A).send({ notes: 'x' }),
        api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: cn('MSKU000001') }),
        api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'x' }),
      ];
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FILE_NOT_EDITABLE');
      }
      expect((await api.req('get', `/clearance-files/${f.id}`, A)).status).toBe(200); // still readable
    });
  });

  describe('assignment', () => {
    it('lets managers assign and reassign, and records it', async () => {
      const f = await ok(mkFile(A));
      const a1 = await ok(api.req('post', `/clearance-files/${f.id}/assign`, manager).send({ userId: ids.officerUser }));
      expect(a1.assignee.id).toBe(ids.officerUser);
      const a2 = await ok(api.req('post', `/clearance-files/${f.id}/assign`, manager).send({ userId: ids.managerUser }));
      expect(a2.assignee.id).toBe(ids.managerUser);
      const a3 = await ok(api.req('post', `/clearance-files/${f.id}/assign`, manager).send({ userId: null }));
      expect(a3.assignee).toBeNull();
      const tl = (await ok(api.req('get', `/clearance-files/${f.id}/timeline`, A))).filter((t: any) => t.activityType === 'EMPLOYEE_ASSIGNED');
      expect(tl).toHaveLength(3);
      expect(tl[0].description).toMatch(/^Unassigned \(was Emp MANAGER\)/);
      // assigning the same person again is a no-op
      await api.req('post', `/clearance-files/${f.id}/assign`, manager).send({ userId: ids.managerUser });
      await api.req('post', `/clearance-files/${f.id}/assign`, manager).send({ userId: ids.managerUser });
      expect((await ok(api.req('get', `/clearance-files/${f.id}/timeline`, A))).filter((t: any) => t.activityType === 'EMPLOYEE_ASSIGNED')).toHaveLength(4);
    });

    it('requires the assign permission and an active employee of the office', async () => {
      const f = await ok(mkFile(A));
      const denied = await api.req('post', `/clearance-files/${f.id}/assign`, officer).send({ userId: ids.officerUser });
      expect(denied.status).toBe(403);
      expect((await api.req('post', `/clearance-files/${f.id}/assign`, A).send({ userId: ids.clientB })).body.error.code).toBe('ASSIGNEE_NOT_FOUND');
      expect((await api.req('post', `/clearance-files/${f.id}/assign`, A).send({})).status).toBe(400);
    });
  });

  describe('shipments, containers and goods', () => {
    let fileId: string;
    let shipment: any;
    let agentId: string;
    let beirut: string;
    let shanghai: string;

    beforeAll(async () => {
      fileId = (await ok(mkFile(A, { customsReference: 'SHIP-TEST' }))).id;
      agentId = (await ok(api.req('post', '/parties', A).send({ name: 'Med Agency', partyType: 'SHIPPING_AGENT' }))).id;
      const ports = await ok(api.req('get', '/ports?limit=100', A));
      beirut = ports.find((p: any) => p.code === 'LBBEY').id;
      shanghai = ports.find((p: any) => p.code === 'CNSHA').id;
    });

    it('adds multiple shipments to one file with vessel, BL, parties, ports and dates', async () => {
      shipment = await ok(api.req('post', `/clearance-files/${fileId}/shipments`, A).send({
        vesselName: 'MSC Aurora', voyageNumber: 'V123', billOfLadingNumber: 'BL-777', masterBlNumber: 'MBL-1', houseBlNumber: 'HBL-1',
        shippingAgentId: agentId, originPortId: shanghai, destinationPortId: beirut,
        etd: '2026-11-01T00:00:00Z', eta: '2026-11-20T08:00:00Z',
      }));
      expect(shipment).toMatchObject({
        shipmentType: 'SEA', vesselName: 'MSC Aurora', billOfLadingNumber: 'BL-777',
        shippingAgent: { name: 'Med Agency' }, originPort: { code: 'CNSHA' }, destinationPort: { code: 'LBBEY' },
      });
      await ok(api.req('post', `/clearance-files/${fileId}/shipments`, A).send({ shipmentType: 'AIR' })); // empty second shipment is fine
      const list = await ok(api.req('get', `/clearance-files/${fileId}/shipments`, A));
      expect(list).toHaveLength(2);
    });

    it('lists shipments across the office, with search, filters, the file and client, and tenant isolation', async () => {
      const cont = await ok(api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: cn('TGHU123456') }));
      const all = await api.req('get', '/shipments?limit=100', A);
      expect(all.status).toBe(200);
      expect(all.body.meta.total).toBeGreaterThanOrEqual(2);
      const row = all.body.data.find((s: any) => s.id === shipment.id);
      expect(row).toMatchObject({ vesselName: 'MSC Aurora', clearanceFile: { id: fileId, client: { name: 'Acme Trading' } }, originPort: { code: 'CNSHA' }, _count: { containers: 1 } });

      const ids = async (qs: string) => (await ok(api.req('get', `/shipments?${qs}`, A))).map((s: any) => s.id);
      expect(await ids('search=BL-777')).toEqual([shipment.id]); // bill of lading
      expect(await ids('search=aurora')).toEqual([shipment.id]); // vessel, case-insensitive
      expect(await ids(`search=${cont.containerNumber}`)).toEqual([shipment.id]); // via a container number
      expect(await ids('search=%25')).toEqual([]); // % is literal, not a wildcard
      expect(await ids(`clearanceFileId=${fileId}&shipmentType=AIR`)).toHaveLength(1);
      expect(await ids(`clearanceFileId=${fileId}&from=2026-11-19&to=2026-11-21`)).toEqual([shipment.id]); // ETA in range
      expect(await ids(`clearanceFileId=${fileId}&from=2026-12-01`)).toEqual([]);
      expect(await ids(`clearanceFileId=${fileId}&arrived=true`)).toEqual([]);
      expect(await ids(`clearanceFileId=${fileId}&arrived=false`)).toHaveLength(2);

      expect((await api.req('get', '/shipments?shipmentType=BOAT', A)).status).toBe(400);
      expect((await ok(api.req('get', '/shipments?limit=100', B))).map((s: any) => s.id)).not.toContain(shipment.id); // another office never sees it
      expect((await api.req('get', '/shipments', viewer)).status).toBe(200); // clearance_files.view is enough
    });

    it('validates references and dates', async () => {
      const bad = async (body: object, code: string) => {
        const res = await api.req('post', `/clearance-files/${fileId}/shipments`, A).send(body);
        expect(res.status, code).toBe(422);
        expect(res.body.error.code).toBe(code);
      };
      await bad({ shippingAgentId: '00000000-0000-4000-8000-000000000000' }, 'PARTY_NOT_FOUND');
      const forwarder = (await ok(api.req('post', '/parties', A).send({ name: 'Fast Forwarding', partyType: 'FREIGHT_FORWARDER' }))).id;
      await bad({ shippingAgentId: forwarder }, 'PARTY_WRONG_KIND'); // a forwarder is not a shipping agent
      await bad({ freightForwarderId: agentId }, 'PARTY_WRONG_KIND');
      await bad({ originPortId: '00000000-0000-4000-8000-000000000000' }, 'PORT_NOT_FOUND');
      await bad({ etd: '2026-11-20T00:00:00Z', eta: '2026-11-01T00:00:00Z' }, 'ETA_BEFORE_ETD');
      const upd = await api.req('patch', `/shipments/${shipment.id}`, A).send({ eta: '2026-10-01T00:00:00Z' }); // before stored ETD
      expect(upd.body.error.code).toBe('ETA_BEFORE_ETD');
    });

    it('updates a shipment and logs arrival on the timeline', async () => {
      const upd = await ok(api.req('patch', `/shipments/${shipment.id}`, A).send({ actualArrivalAt: '2026-11-19T06:00:00Z', vesselName: 'MSC Aurora II' }));
      expect(upd.vesselName).toBe('MSC Aurora II');
      const tl = await ok(api.req('get', `/clearance-files/${fileId}/timeline`, A));
      expect(tl.map((t: any) => t.activityType)).toEqual(expect.arrayContaining(['SHIPMENT_ADDED', 'SHIPMENT_ARRIVED']));
    });

    it('records ISO 6346 containers, normalising the typed number', async () => {
      const valid = cn('MSKU123456');
      const c = await ok(api.req('post', `/shipments/${shipment.id}/containers`, A).send({
        containerNumber: valid.toLowerCase().replace(/^(.{4})/, '$1 '), containerType: '40HC', sealNumber: 'SEAL-1',
        grossWeight: '25000.5', netWeight: 24000, packageCount: 1200,
      }));
      expect(c).toMatchObject({ containerNumber: valid, grossWeight: '25000.500', netWeight: '24000.000', packageCount: 1200, status: 'PLANNED' });
    });

    it('rejects a wrong check digit and tells the user what it should be', async () => {
      const good = cn('TEMU600005');
      const wrong = good.slice(0, 10) + ((Number(good[10]) + 1) % 10);
      const res = await api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: wrong });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('INVALID_CONTAINER_CHECK_DIGIT');
      expect(res.body.error.details[0].expectedCheckDigit).toBe(Number(good[10]));
      // an explicit "non-standard" flag does NOT bypass a bad check digit on an ISO-format number
      const flagged = await api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: wrong, nonStandardNumber: true });
      expect(flagged.body.error.code).toBe('INVALID_CONTAINER_CHECK_DIGIT');
    });

    it('accepts a non-ISO number only with explicit confirmation', async () => {
      const refused = await api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: 'oldbox 42' });
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('CONTAINER_NUMBER_NOT_ISO6346');
      const allowed = await api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: 'oldbox 42', nonStandardNumber: true });
      expect(allowed.status).toBe(201);
      expect(allowed.body.data.containerNumber).toBe('OLDBOX42');
    });

    it('prevents duplicates, impossible weights, and lets status and details change', async () => {
      const dup = await api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: cn('MSKU123456') });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('CONTAINER_DUPLICATE');
      const heavy = await api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: cn('TEMU600005'), grossWeight: 100, netWeight: 200 });
      expect(heavy.body.error.code).toBe('NET_WEIGHT_EXCEEDS_GROSS');
      const c2 = await ok(api.req('post', `/shipments/${shipment.id}/containers`, A).send({ containerNumber: cn('TEMU600005') }));
      expect((await api.req('patch', `/containers/${c2.id}`, A).send({ containerNumber: cn('MSKU123456') })).status).toBe(409);
      const upd = await ok(api.req('patch', `/containers/${c2.id}`, A).send({ status: 'AT_PORT', sealNumber: 'S-9', grossWeight: 500, netWeight: 400 }));
      expect(upd).toMatchObject({ status: 'AT_PORT', sealNumber: 'S-9', grossWeight: '500.000' });
      expect((await api.req('patch', `/containers/${c2.id}`, A).send({ netWeight: 900 })).body.error.code).toBe('NET_WEIGHT_EXCEEDS_GROSS');
      expect((await api.req('patch', `/containers/${c2.id}`, A).send({ status: 'EXPLODED' })).status).toBe(400);
    });

    it('computes goods line totals on the server and validates references', async () => {
      const g = await ok(api.req('post', `/shipments/${shipment.id}/goods`, A).send({
        description: 'Ceramic tiles 60x60', quantity: 1200, unitOfMeasure: 'M2', unitPrice: '8.75', currencyCode: 'usd',
        countryOfOrigin: 'cn', grossWeight: 22000, netWeight: 21000, lineTotal: '1.00', // client total is ignored
      }));
      expect(g).toMatchObject({ lineTotal: '10500.0000', unitPrice: '8.7500', quantity: '1200.0000', currencyCode: 'USD', countryOfOrigin: 'CN' });

      const noCur = await api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'x', unitPrice: 5 });
      expect(noCur.body.error.code).toBe('CURRENCY_REQUIRED');
      expect((await api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'x', unitPrice: 5, currencyCode: 'ZZZ' })).body.error.code).toBe('CURRENCY_NOT_FOUND');
      expect((await api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'x', hsCodeId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('HS_CODE_NOT_FOUND');
      expect((await api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'x', grossWeight: 1, netWeight: 2 })).body.error.code).toBe('NET_WEIGHT_EXCEEDS_GROSS');
      expect((await api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: '' })).status).toBe(400);
      expect((await api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'x', quantity: -3 })).status).toBe(400);

      const upd = await ok(api.req('patch', `/goods/${g.id}`, A).send({ quantity: 1000, lineTotal: '5.00' }));
      expect(upd.lineTotal).toBe('8750.0000'); // recomputed from the merged quantity and price
      const total = await ok(api.req('post', `/shipments/${shipment.id}/goods`, A).send({ description: 'Lump-sum item', lineTotal: '300.5', currencyCode: 'EUR' }));
      expect(total.lineTotal).toBe('300.5000'); // no unit price: the given total is kept
    });

    it('shows containers and goods with the shipment and summarises the file', async () => {
      const full = await ok(api.req('get', `/shipments/${shipment.id}`, A));
      expect(full.containers.length).toBeGreaterThanOrEqual(3);
      expect(full.goodsItems.length).toBeGreaterThanOrEqual(2);
      const sum = await ok(api.req('get', `/clearance-files/${fileId}/summary`, A));
      expect(sum.counts).toMatchObject({ shipments: 2, containers: full.containers.length, goodsLines: full.goodsItems.length, documents: 0, openTasks: 0 });
      expect(sum.goodsValueByCurrency).toEqual({ USD: '8750.0000', EUR: '300.5000' });
      expect(sum.totals.packages).toBe(1200);
      expect(sum.file.customsReference).toBe('SHIP-TEST');
      expect(sum.financial).toBeNull();
      expect(new Date(sum.nextEta).toISOString()).toBe('2026-11-20T08:00:00.000Z');
    });

    it('serves a paginated timeline, newest first, with user names', async () => {
      const page1 = await api.req('get', `/clearance-files/${fileId}/timeline?limit=3`, A);
      expect(page1.body.meta.limit).toBe(3);
      expect(page1.body.meta.total).toBeGreaterThan(8);
      expect(page1.body.data).toHaveLength(3);
      const times = page1.body.data.map((t: any) => new Date(t.createdAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(page1.body.data[0].user).toMatchObject({ firstName: 'Owner' });
    });
  });

  describe('removing shipments, containers and goods', () => {
    it('removes a container or goods line, then a whole shipment with what is on it, keeping an audit trail', async () => {
      const fid = (await ok(mkFile(A))).id;
      const sh = await ok(api.req('post', `/clearance-files/${fid}/shipments`, A).send({ vesselName: 'Mistake' }));
      const c1 = await ok(api.req('post', `/shipments/${sh.id}/containers`, A).send({ containerNumber: cn('MSCU123456'), containerType: '40HC' }));
      await ok(api.req('post', `/shipments/${sh.id}/containers`, A).send({ containerNumber: cn('TEMU765432'), containerType: '40HC' }));
      const g1 = await ok(api.req('post', `/shipments/${sh.id}/goods`, A).send({ description: 'Tiles' }));
      await ok(api.req('post', `/shipments/${sh.id}/goods`, A).send({ description: 'Pallets' }));

      expect((await api.req('delete', `/containers/${c1.id}`, viewer)).status).toBe(403);
      expect((await api.req('delete', `/containers/${c1.id}`, A)).status).toBe(204);
      expect((await api.req('delete', `/containers/${c1.id}`, A)).status).toBe(404);
      expect((await api.req('delete', `/goods/${g1.id}`, A)).status).toBe(204);
      expect((await ok(api.req('get', `/shipments/${sh.id}`, A))).containers).toHaveLength(1);
      expect((await ok(api.req('get', `/shipments/${sh.id}`, A))).goodsItems).toHaveLength(1);

      expect((await api.req('delete', `/shipments/${sh.id}`, B)).status).toBe(404); // another office
      expect((await api.req('delete', `/shipments/${sh.id}`, A)).status).toBe(204);
      expect((await api.req('get', `/shipments/${sh.id}`, A)).status).toBe(404);
      expect(await api.prisma.container.count({ where: { shipmentId: sh.id } })).toBe(0);
      expect(await api.prisma.goodsItem.count({ where: { shipmentId: sh.id } })).toBe(0);
      expect(await api.prisma.auditLog.count({ where: { entityId: sh.id, action: 'SHIPMENT_DELETED' } })).toBe(1);
      expect(await api.prisma.auditLog.count({ where: { entityId: c1.id, action: 'CONTAINER_DELETED' } })).toBe(1);
    });

    it('cannot change a shipments of a closed file', async () => {
      const fid = (await ok(mkFile(A))).id;
      const sh = await ok(api.req('post', `/clearance-files/${fid}/shipments`, A).send({ vesselName: 'Keep' }));
      await api.prisma.clearanceFile.update({ where: { id: fid }, data: { status: 'CLOSED' } });
      expect((await api.req('delete', `/shipments/${sh.id}`, A)).status).toBeGreaterThanOrEqual(400);
      expect((await api.req('get', `/shipments/${sh.id}`, A)).status).toBe(200);
    });
  });

  describe('searching and filtering the file list', () => {
    let target: string;

    beforeAll(async () => {
      const client = await ok(api.req('post', '/clients', A).send({ name: 'Zenith Imports', clientCode: 'ZEN1' }));
      const f = await ok(mkFile(A, { clientId: client.id, customsReference: 'CUSTOMS-XYZ-9', assignedTo: ids.officerUser, priority: 'HIGH' }));
      target = f.id;
      const s = await ok(api.req('post', `/clearance-files/${f.id}/shipments`, A).send({ billOfLadingNumber: 'MAEU-98765', masterBlNumber: 'MBL-ZED', vesselName: 'Ever Given' }));
      await ok(api.req('post', `/shipments/${s.id}/containers`, A).send({ containerNumber: cn('CMAU765432') }));
      await api.prisma.invoice.create({
        data: {
          tenantId: tenantAId, clearanceFileId: f.id, clientId: client.id, invoiceNumber: 'INV-2026-0042', currencyCode: 'USD',
          subtotal: '1.0000', totalAmount: '1.0000', createdBy: ids.ownerA,
        },
      });
    });

    const search = async (term: string, token = A) =>
      (await ok(api.req('get', `/clearance-files?search=${encodeURIComponent(term)}&limit=100`, token))).map((f: any) => f.id);

    it('finds a file by file number, customs reference, client name/code, BL, vessel, container and invoice number', async () => {
      const fileNumber = (await ok(api.req('get', `/clearance-files/${target}`, A))).fileNumber;
      for (const term of [
        fileNumber, 'customs-xyz', 'zenith', 'zen1', 'MAEU-98765', 'maeu-9', 'MBL-ZED', 'ever given',
        cn('CMAU765432'), cn('CMAU765432').toLowerCase(), `${cn('CMAU765432').slice(0, 4)} ${cn('CMAU765432').slice(4)}`,
        `${cn('CMAU765432').slice(0, 4)}-${cn('CMAU765432').slice(4)}`, 'INV-2026-0042', 'inv-2026',
      ]) {
        expect(await search(term), `search "${term}"`).toEqual([target]);
      }
    });

    it('returns nothing for unknown terms and treats wildcards literally', async () => {
      for (const term of ['no-such-thing', '%', '_', 'CUSTOMS%9', "'; DROP TABLE clearance_files; --"]) {
        expect(await search(term), term).toEqual([]);
      }
      expect((await api.req('get', '/clearance-files?limit=1', A)).body.meta.total).toBeGreaterThan(10);
    });

    it('filters by assignee (including "me" and "unassigned"), priority, status, type and stage', async () => {
      const mine = await ok(api.req('get', '/clearance-files?assignedTo=me&limit=100', officer));
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.every((f: any) => f.assignee?.id === ids.officerUser)).toBe(true);
      const unassigned = await ok(api.req('get', '/clearance-files?assignedTo=unassigned&limit=100', A));
      expect(unassigned.every((f: any) => f.assignee === null)).toBe(true);
      expect((await ok(api.req('get', '/clearance-files?priority=HIGH&limit=100', A))).map((f: any) => f.id)).toContain(target);
      expect((await ok(api.req('get', '/clearance-files?status=CLOSED', A))).every((f: any) => f.status === 'CLOSED')).toBe(true);
      const exports = await ok(api.req('get', '/clearance-files?fileType=EXPORT&limit=100', A));
      expect(exports.every((f: any) => f.fileType === 'EXPORT' && f.fileNumber.startsWith('EXP-'))).toBe(true);
      const atStage = await ok(api.req('get', '/clearance-files?stage=NEW_FILE&limit=100', A));
      expect(atStage.length).toBeGreaterThan(0);
      expect((await ok(api.req('get', '/clearance-files?stage=CUSTOMS_RELEASE', A)))).toEqual([]);
    });

    it('filters by opening date and client, sorts, and pages on the server', async () => {
      expect((await ok(api.req('get', '/clearance-files?openedFrom=2000-01-01&openedTo=2000-12-31', A)))).toEqual([]);
      const today = new Date().toISOString().slice(0, 10);
      expect((await ok(api.req('get', `/clearance-files?openedFrom=${today}&openedTo=${today}&limit=100`, A))).length).toBeGreaterThan(10);
      const zen = await api.prisma.client.findFirstOrThrow({ where: { clientCode: 'ZEN1' } });
      expect((await ok(api.req('get', `/clearance-files?clientId=${zen.id}`, A))).map((f: any) => f.id)).toEqual([target]);

      const p1 = await api.req('get', '/clearance-files?limit=5&page=1&sort=fileNumber:asc&fileType=IMPORT', A);
      const p2 = await api.req('get', '/clearance-files?limit=5&page=2&sort=fileNumber:asc&fileType=IMPORT', A);
      expect(p1.body.data).toHaveLength(5);
      expect(p1.body.meta.total).toBeGreaterThan(5);
      const nums = [...p1.body.data, ...p2.body.data].map((f: any) => f.fileNumber);
      expect([...nums].sort()).toEqual(nums);
      expect(new Set(nums).size).toBe(10);
      // unknown sort field falls back instead of reaching the database
      expect((await api.req('get', '/clearance-files?sort=internalNotes:asc', A)).status).toBe(200);
      expect((await api.req('get', '/clearance-files?limit=500', A)).status).toBe(400);
    });

    it('does not expose internal notes in list rows', async () => {
      const rows = await ok(api.req('get', '/clearance-files?limit=3', A));
      expect(Object.keys(rows[0])).not.toContain('internalNotes');
    });
  });

  describe('permissions', () => {
    it('lets viewers read but not change anything', async () => {
      const f = await ok(mkFile(A));
      expect((await api.req('get', '/clearance-files', viewer)).status).toBe(200);
      expect((await api.req('get', `/clearance-files/${f.id}`, viewer)).status).toBe(200);
      expect((await api.req('get', `/clearance-files/${f.id}/summary`, viewer)).status).toBe(200);
      const denied = [
        mkFile(viewer), api.req('patch', `/clearance-files/${f.id}`, viewer).send({ priority: 'LOW' }),
        api.req('post', `/clearance-files/${f.id}/shipments`, viewer).send({}),
        api.req('post', `/clearance-files/${f.id}/assign`, viewer).send({ userId: null }),
      ];
      for (const res of await Promise.all(denied)) expect(res.status).toBe(403);
    });

    it('lets clearance officers create and edit but not assign', async () => {
      const f = await ok(mkFile(officer));
      expect(f.createdBy.firstName).toBe('Emp');
      expect((await api.req('patch', `/clearance-files/${f.id}`, officer).send({ priority: 'LOW' })).status).toBe(200);
      expect((await api.req('post', `/clearance-files/${f.id}/assign`, officer).send({ userId: ids.officerUser })).status).toBe(403);
    });
  });

  describe('office isolation', () => {
    let bFile: any;
    let bShipment: any;
    let bContainer: any;
    let bGoods: any;
    let bParty: any;

    beforeAll(async () => {
      bFile = await ok(api.req('post', '/clearance-files', B).send({ fileType: 'IMPORT', clientId: ids.clientB, customsReference: 'B-SECRET-REF' }));
      bShipment = await ok(api.req('post', `/clearance-files/${bFile.id}/shipments`, B).send({ billOfLadingNumber: 'B-SECRET-BL' }));
      bContainer = await ok(api.req('post', `/shipments/${bShipment.id}/containers`, B).send({ containerNumber: cn('HLXU000001') }));
      bGoods = await ok(api.req('post', `/shipments/${bShipment.id}/goods`, B).send({ description: 'B secret goods' }));
      bParty = await ok(api.req('post', '/parties', B).send({ name: 'B party', partyType: 'SUPPLIER' }));
    });

    it('never lists or searches another office\'s files', async () => {
      for (const term of ['B-SECRET-REF', 'B-SECRET-BL', cn('HLXU000001'), 'Beta Client']) {
        expect((await ok(api.req('get', `/clearance-files?search=${term}`, A))), term).toEqual([]);
      }
      const all = await ok(api.req('get', '/clearance-files?limit=100', A));
      expect(all.some((f: any) => f.id === bFile.id)).toBe(false);
    });

    it('answers 404 on every file, shipment, container and goods route for a foreign id', async () => {
      const calls: [Parameters<TestApi['req']>[0], string, object?][] = [
        ['get', `/clearance-files/${bFile.id}`], ['patch', `/clearance-files/${bFile.id}`, { priority: 'LOW' }],
        ['post', `/clearance-files/${bFile.id}/assign`, { userId: null }], ['get', `/clearance-files/${bFile.id}/timeline`],
        ['get', `/clearance-files/${bFile.id}/summary`], ['get', `/clearance-files/${bFile.id}/shipments`],
        ['post', `/clearance-files/${bFile.id}/shipments`, {}],
        ['get', `/shipments/${bShipment.id}`], ['patch', `/shipments/${bShipment.id}`, { notes: 'x' }],
        ['post', `/shipments/${bShipment.id}/containers`, { containerNumber: cn('MSKU000009') }],
        ['patch', `/containers/${bContainer.id}`, { sealNumber: 'x' }],
        ['post', `/shipments/${bShipment.id}/goods`, { description: 'planted' }],
        ['patch', `/goods/${bGoods.id}`, { description: 'hacked' }],
      ];
      for (const [method, path, body] of calls) {
        const res = await api.req(method, path, A).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      const intact = await ok(api.req('get', `/shipments/${bShipment.id}`, B));
      expect(intact.containers).toHaveLength(1);
      expect(intact.goodsItems).toHaveLength(1);
      expect(intact.goodsItems[0].description).toBe('B secret goods');
      expect((await ok(api.req('get', `/clearance-files/${bFile.id}`, B))).priority).toBe('NORMAL');
    });

    it('rejects attaching another office\'s party to a shipment', async () => {
      const f = await ok(mkFile(A));
      const res = await api.req('post', `/clearance-files/${f.id}/shipments`, A).send({ shippingAgentId: bParty.id });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('PARTY_NOT_FOUND');
    });
  });

  describe('reference data', () => {
    it('searches and filters ports (global reference data)', async () => {
      const lebanon = await ok(api.req('get', '/ports?countryCode=lb&limit=100', A));
      expect(lebanon.map((p: any) => p.code)).toEqual(expect.arrayContaining(['LBBEY', 'LBTRI']));
      expect(lebanon.every((p: any) => p.countryCode === 'LB')).toBe(true);
      expect((await ok(api.req('get', '/ports?search=tripoli', A))).map((p: any) => p.code)).toEqual(['LBTRI']);
      expect((await ok(api.req('get', '/ports?portType=AIR', A))).map((p: any) => p.code)).toContain('LBBEA');
      expect((await ok(api.req('get', '/ports?search=%25', A)))).toEqual([]);
    });

    it('serves an HS-code lookup that is empty until verified tariff data is loaded', async () => {
      const res = await api.req('get', '/hs-codes', A);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta.total).toBe(0);
    });
  });

  describe('an office without a workflow template', () => {
    it('still creates the file, with no stage and no history', async () => {
      await provision(api, 'no-workflow', 'owner@no-wf.test');
      const t = (await signIn(api, 'owner@no-wf.test')).accessToken;
      const tenant = await api.prisma.tenant.findUniqueOrThrow({ where: { slug: 'no-workflow' } });
      await api.prisma.workflowTemplate.updateMany({ where: { tenantId: tenant.id }, data: { isActive: false } });
      const client = await ok(api.req('post', '/clients', t).send({ name: 'Client NW' }));
      const f = await ok(api.req('post', '/clearance-files', t).send({ fileType: 'IMPORT', clientId: client.id }));
      expect(f.currentStage).toBeNull();
      expect(f.workflowTemplate).toBeNull();
      expect(await api.prisma.fileStatusHistory.count({ where: { clearanceFileId: f.id } })).toBe(0);
    });
  });
});
