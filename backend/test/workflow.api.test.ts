import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';

const pdf = (t = 'x') => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);

describe('workflow engine API', () => {
  let api: TestApi;
  let A: string; // owner
  let B: string;
  let officer: string; // view/create/update/transition + documents upload + tasks.manage; NO close, approve, review
  let manager: string; // everything operational incl. close, approve, review, workflows.manage
  let viewer: string;
  let tenantAId: string;
  let ownerId: string;
  let officerId: string;
  let clientId: string;
  let types: Record<string, string>;

  const ok = async (p: any) => {
    const res = await p;
    if (res.status >= 300) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const newFile = (token = A, body: Record<string, unknown> = {}) =>
    ok(api.req('post', '/clearance-files', token).send({ fileType: 'IMPORT', clientId, ...body }));
  const move = (token: string, fileId: string, toStageCode: string, reason?: string) =>
    api.req('post', `/clearance-files/${fileId}/transition`, token).send({ toStageCode, reason });
  const addDoc = (token: string, fileId: string, code: string, name = `${code}.pdf`) =>
    api.req('post', `/clearance-files/${fileId}/documents`, token).field('documentTypeId', types[code]).attach('file', pdf(code), name);
  const stageOf = async (fileId: string) => (await ok(api.req('get', `/clearance-files/${fileId}`, A))).currentStage.code;

  /** Brings a fresh import file to PRE_CLEARANCE (the stage before the document-gated one). */
  async function toPreClearance(token = officer) {
    const f = await newFile();
    await ok(move(token, f.id, 'DOCUMENT_COLLECTION'));
    await ok(move(token, f.id, 'PRE_CLEARANCE'));
    return f;
  }
  const uploadRequired = async (fileId: string) => {
    for (const code of ['COMMERCIAL_INVOICE', 'PACKING_LIST', 'BILL_OF_LADING']) await ok(addDoc(officer, fileId, code));
  };

  beforeAll(async () => {
    api = await startApi();
    const a = await provision(api, 'wf-a', 'owner@wf-a.test');
    await provision(api, 'wf-b', 'owner@wf-b.test');
    tenantAId = a.tenantId;
    A = (await signIn(api, 'owner@wf-a.test')).accessToken;
    B = (await signIn(api, 'owner@wf-b.test')).accessToken;
    officerId = (await createUser(api, A, 'officer@wf-a.test', 'CLEARANCE_OFFICER')).id;
    await createUser(api, A, 'manager@wf-a.test', 'MANAGER');
    await createUser(api, A, 'viewer@wf-a.test', 'VIEWER');
    officer = (await signIn(api, 'officer@wf-a.test')).accessToken;
    manager = (await signIn(api, 'manager@wf-a.test')).accessToken;
    viewer = (await signIn(api, 'viewer@wf-a.test')).accessToken;
    ownerId = (await ok(api.req('get', '/auth/me', A))).user.id;
    clientId = (await ok(api.req('post', '/clients', A).send({ name: 'Workflow Client' }))).id;
    types = Object.fromEntries((await ok(api.req('get', '/document-types', A))).map((t: any) => [t.code, t.id]));
  });
  afterAll(async () => api.close());

  describe('moving a file through the default import workflow', () => {
    it('starts at NEW_FILE and offers only the configured next step', async () => {
      const f = await newFile();
      const next = await ok(api.req('get', `/clearance-files/${f.id}/transitions`, officer));
      expect(next.currentStage.code).toBe('NEW_FILE');
      expect(next.transitions.map((t: any) => t.toStage.code)).toEqual(['DOCUMENT_COLLECTION']);
      expect(next.transitions[0]).toMatchObject({ allowed: true, blockers: [], requiresReason: false });
    });

    it('walks the whole lifecycle, enforcing gates and recording history, timeline and notifications', async () => {
      const f = await newFile(A, { assignedTo: officerId });
      await ok(move(officer, f.id, 'DOCUMENT_COLLECTION'));
      await ok(move(officer, f.id, 'PRE_CLEARANCE'));

      // declaration needs the three required documents
      const blocked = await move(officer, f.id, 'DECLARATION_SUBMITTED');
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('REQUIRED_DOCUMENTS_MISSING');
      expect(blocked.body.error.details[0].details.map((d: any) => d.code).sort())
        .toEqual(['BILL_OF_LADING', 'COMMERCIAL_INVOICE', 'PACKING_LIST']);
      expect(await stageOf(f.id)).toBe('PRE_CLEARANCE'); // unchanged

      await uploadRequired(f.id);
      await ok(move(officer, f.id, 'DECLARATION_SUBMITTED'));
      await ok(move(officer, f.id, 'ASSESSMENT_INSPECTION'));
      await ok(move(officer, f.id, 'DUTIES_CHARGES'));
      await ok(move(officer, f.id, 'CUSTOMS_RELEASE'));

      // the final stage needs the closing permission, which an officer lacks
      const denied = await move(officer, f.id, 'DELIVERY_CLOSURE');
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('PERMISSION_DENIED');
      expect(denied.body.error.details[0].details.permission).toBe('clearance_files.close');
      const done = await ok(move(manager, f.id, 'DELIVERY_CLOSURE'));
      expect(done.currentStage).toMatchObject({ code: 'DELIVERY_CLOSURE', isTerminal: true });
      expect(done.status).toBe('OPEN'); // reaching the final stage does not close the file by itself

      const history = await ok(api.req('get', `/clearance-files/${f.id}/status-history`, A));
      expect(history.map((h: any) => [h.fromStage?.code ?? null, h.toStage.code])).toEqual([
        [null, 'NEW_FILE'], ['NEW_FILE', 'DOCUMENT_COLLECTION'], ['DOCUMENT_COLLECTION', 'PRE_CLEARANCE'],
        ['PRE_CLEARANCE', 'DECLARATION_SUBMITTED'], ['DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION'],
        ['ASSESSMENT_INSPECTION', 'DUTIES_CHARGES'], ['DUTIES_CHARGES', 'CUSTOMS_RELEASE'], ['CUSTOMS_RELEASE', 'DELIVERY_CLOSURE'],
      ]);
      expect(history[7].changedBy).toMatchObject({ firstName: 'Emp', lastName: 'MANAGER' });

      const tl = await ok(api.req('get', `/clearance-files/${f.id}/timeline?limit=100`, A));
      expect(tl.filter((t: any) => t.activityType === 'STAGE_CHANGED')).toHaveLength(7);
      expect(tl.find((t: any) => t.activityType === 'STAGE_CHANGED').description).toMatch(/^Stage changed from Customs release to Delivery and file closure/);
      // the assigned officer is told when someone else moves their file
      const notes = await api.prisma.notification.findMany({ where: { userId: officerId, type: 'FILE_STAGE_CHANGED' } });
      expect(notes.some((n) => (n.metadata as any).clearanceFileId === f.id && (n.metadata as any).toStage === 'DELIVERY_CLOSURE')).toBe(true);
    });

    it('rejects skipping stages and unknown targets, and lists the legal options', async () => {
      const f = await newFile();
      const skip = await move(officer, f.id, 'CUSTOMS_RELEASE');
      expect(skip.status).toBe(409);
      expect(skip.body.error.code).toBe('TRANSITION_NOT_ALLOWED');
      expect(skip.body.error.details).toEqual([{ allowedTo: 'DOCUMENT_COLLECTION', nameEn: 'Document collection' }]);
      expect((await move(officer, f.id, 'NO_SUCH_STAGE')).body.error.code).toBe('TRANSITION_NOT_ALLOWED');
      expect((await move(officer, f.id, 'NEW_FILE')).body.error.code).toBe('TRANSITION_NOT_ALLOWED'); // staying put
      expect(await stageOf(f.id)).toBe('NEW_FILE');
    });

    it('accepts a stage id as well as a code, and requires exactly one of them', async () => {
      const f = await newFile();
      const tpl = (await ok(api.req('get', `/workflow-templates?fileType=IMPORT`, A)))[0];
      const target = tpl.stages.find((s: any) => s.code === 'DOCUMENT_COLLECTION');
      const res = await api.req('post', `/clearance-files/${f.id}/transition`, officer).send({ toStageId: target.id });
      expect(res.status).toBe(200);
      expect(res.body.data.currentStage.code).toBe('DOCUMENT_COLLECTION');
      expect((await api.req('post', `/clearance-files/${f.id}/transition`, officer).send({})).status).toBe(400);
      expect((await api.req('post', `/clearance-files/${f.id}/transition`, officer).send({ toStageId: target.id, toStageCode: 'X1' })).status).toBe(400);
      expect((await api.req('post', `/clearance-files/${f.id}/transition`, officer).send({ toStageCode: 'PRE_CLEARANCE', status: 'CLOSED' })).status).toBe(400); // strict body
    });

    it('requires a reason to move backwards and records it', async () => {
      const f = await toPreClearance();
      const noReason = await move(officer, f.id, 'DOCUMENT_COLLECTION');
      expect(noReason.status).toBe(422);
      expect(noReason.body.error.code).toBe('REASON_REQUIRED');
      expect((await move(officer, f.id, 'DOCUMENT_COLLECTION', 'ab')).body.error.code).toBe('REASON_REQUIRED'); // too short
      await ok(move(officer, f.id, 'DOCUMENT_COLLECTION', 'Supplier sent a corrected invoice'));
      const history = await ok(api.req('get', `/clearance-files/${f.id}/status-history`, A));
      expect(history.at(-1)).toMatchObject({ reason: 'Supplier sent a corrected invoice' });
      expect(history.at(-1).fromStage.code).toBe('PRE_CLEARANCE');
    });

    it('lets only people with the transition permission move a file (checked by the backend)', async () => {
      const f = await newFile();
      const res = await move(viewer, f.id, 'DOCUMENT_COLLECTION');
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('PERMISSION_DENIED');
      expect(await stageOf(f.id)).toBe('NEW_FILE');
      const next = await ok(api.req('get', `/clearance-files/${f.id}/transitions`, viewer));
      expect(next.transitions[0]).toMatchObject({ allowed: false });
      expect(next.transitions[0].blockers[0].code).toBe('PERMISSION_DENIED');
    });

    it('explains blockers through the transitions endpoint and agrees with enforcement', async () => {
      const f = await toPreClearance();
      const before = (await ok(api.req('get', `/clearance-files/${f.id}/transitions`, officer))).transitions;
      const decl = before.find((t: any) => t.toStage.code === 'DECLARATION_SUBMITTED');
      expect(decl.allowed).toBe(false);
      expect(decl.blockers.map((b: any) => b.code)).toEqual(['REQUIRED_DOCUMENTS_MISSING']);
      expect(decl.requiresDocumentCheck).toBe(true);
      await uploadRequired(f.id);
      const after = (await ok(api.req('get', `/clearance-files/${f.id}/transitions`, officer))).transitions;
      expect(after.find((t: any) => t.toStage.code === 'DECLARATION_SUBMITTED').allowed).toBe(true);
      expect((await move(officer, f.id, 'DECLARATION_SUBMITTED')).status).toBe(200);
    });

    it('lets exactly one of two simultaneous moves win', async () => {
      const f = await newFile();
      const results = await Promise.all([move(officer, f.id, 'DOCUMENT_COLLECTION'), move(manager, f.id, 'DOCUMENT_COLLECTION')]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const history = await ok(api.req('get', `/clearance-files/${f.id}/status-history`, A));
      expect(history).toHaveLength(2); // initial + exactly one move
    });
  });

  describe('required documents', () => {
    it('counts uploaded documents, but not rejected or voided ones', async () => {
      const f = await toPreClearance();
      await uploadRequired(f.id);
      const inv = (await ok(api.req('get', `/clearance-files/${f.id}/documents`, A))).find((d: any) => d.documentType.code === 'COMMERCIAL_INVOICE');
      await ok(api.req('patch', `/documents/${inv.id}/status`, manager).send({ status: 'REJECTED', note: 'Wrong consignee' }));
      let blocked = await move(officer, f.id, 'DECLARATION_SUBMITTED');
      expect(blocked.body.error.details[0].details).toEqual([expect.objectContaining({ code: 'COMMERCIAL_INVOICE', state: 'REJECTED_ONLY' })]);
      const cl = await ok(api.req('get', `/clearance-files/${f.id}/document-requirements`, A));
      expect(cl.find((c: any) => c.documentType.code === 'COMMERCIAL_INVOICE')).toMatchObject({ state: 'REJECTED_ONLY', satisfied: false });

      // a corrected re-upload satisfies it; approving it marks it APPROVED
      const fresh = await ok(addDoc(officer, f.id, 'COMMERCIAL_INVOICE', 'corrected.pdf'));
      await ok(api.req('patch', `/documents/${fresh.id}/status`, manager).send({ status: 'APPROVED' }));
      const cl2 = await ok(api.req('get', `/clearance-files/${f.id}/document-requirements`, A));
      expect(cl2.find((c: any) => c.documentType.code === 'COMMERCIAL_INVOICE')).toMatchObject({ state: 'APPROVED', satisfied: true });

      // voiding the packing list makes it missing again
      const pl = (await ok(api.req('get', `/clearance-files/${f.id}/documents`, A))).find((d: any) => d.documentType.code === 'PACKING_LIST');
      await api.req('delete', `/documents/${pl.id}`, manager);
      blocked = await move(officer, f.id, 'DECLARATION_SUBMITTED');
      expect(blocked.body.error.details[0].details.map((d: any) => d.code)).toEqual(['PACKING_LIST']);
    });

    it('shows the per-file checklist with optional documents that do not block', async () => {
      const f = await newFile();
      const cl = await ok(api.req('get', `/clearance-files/${f.id}/document-requirements`, viewer));
      const byCode = Object.fromEntries(cl.map((c: any) => [c.documentType.code, c]));
      expect(byCode.COMMERCIAL_INVOICE).toMatchObject({ isRequired: true, state: 'MISSING', satisfied: false });
      expect(byCode.COMMERCIAL_INVOICE.requiredBeforeStage.code).toBe('DECLARATION_SUBMITTED');
      expect(byCode.CERTIFICATE_OF_ORIGIN).toMatchObject({ isRequired: false, state: 'MISSING' });
      expect(cl.filter((c: any) => c.isRequired)).toHaveLength(3);
    });

    it('lets administrators configure requirements, including ones that gate closing', async () => {
      // the seed already lists the delivery order as an OPTIONAL import document with no stage
      const seeded = (await ok(api.req('get', '/document-requirements?fileType=IMPORT', manager)))
        .find((r: any) => r.documentType.code === 'DELIVERY_ORDER');
      expect(seeded).toMatchObject({ isRequired: false, requiredBefore: null });
      const dup = await api.req('post', '/document-requirements', manager).send({ fileType: 'IMPORT', documentTypeId: types.DELIVERY_ORDER });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('REQUIREMENT_EXISTS');
      expect((await api.req('patch', `/document-requirements/${seeded.id}`, officer).send({ isRequired: true })).status).toBe(403);
      const exportReq = { body: { data: await ok(api.req('patch', `/document-requirements/${seeded.id}`, manager).send({ isRequired: true, appliesTo: 'all imports' })) } };
      expect(exportReq.body.data).toMatchObject({ isRequired: true, appliesTo: 'all imports', requiredBefore: null });
      // a brand-new requirement can be created and removed
      const extra = await api.req('post', '/document-requirements', manager).send({ fileType: 'EXPORT', documentTypeId: types.DELIVERY_ORDER, isRequired: false });
      expect(extra.status).toBe(201);
      expect((await api.req('delete', `/document-requirements/${extra.body.data.id}`, manager)).status).toBe(204);
      expect((await api.req('delete', `/document-requirements/${extra.body.data.id}`, manager)).status).toBe(404);

      const exportStage = (await ok(api.req('get', '/workflow-templates?fileType=EXPORT', A)))[0].stages[0];
      const mismatch = await api.req('post', '/document-requirements', manager).send({
        fileType: 'IMPORT', documentTypeId: types.PAYMENT_PROOF, isRequiredBeforeStageId: exportStage.id,
      });
      expect(mismatch.body.error.code).toBe('STAGE_FILE_TYPE_MISMATCH');
      expect((await api.req('post', '/document-requirements', officer).send({ fileType: 'IMPORT', documentTypeId: types.PAYMENT_PROOF })).status).toBe(403);

      // a stage-less required document must exist before the file can be closed
      const f = await newFile();
      for (const s of ['DOCUMENT_COLLECTION', 'PRE_CLEARANCE']) await ok(move(manager, f.id, s));
      await uploadRequired(f.id);
      for (const s of ['DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION', 'DUTIES_CHARGES', 'CUSTOMS_RELEASE']) await ok(move(manager, f.id, s));
      const check = await ok(api.req('get', `/clearance-files/${f.id}/closure-check`, A));
      expect(check.blockers.map((b: any) => b.code)).toEqual(['NOT_AT_TERMINAL_STAGE']); // docs are only checked at the final stage
      await ok(move(manager, f.id, 'DELIVERY_CLOSURE'));
      const check2 = await ok(api.req('get', `/clearance-files/${f.id}/closure-check`, A));
      expect(check2.canClose).toBe(false);
      expect(check2.blockers[0]).toMatchObject({ code: 'REQUIRED_DOCUMENTS_MISSING' });
      expect(check2.blockers[0].details[0].code).toBe('DELIVERY_ORDER');
      await ok(addDoc(officer, f.id, 'DELIVERY_ORDER'));
      expect((await ok(api.req('get', `/clearance-files/${f.id}/closure-check`, A))).canClose).toBe(true);

      // restore the seed default (and prove null clears a text field)
      const restored = await ok(api.req('patch', `/document-requirements/${exportReq.body.data.id}`, manager).send({ isRequired: false, appliesTo: null }));
      expect(restored).toMatchObject({ isRequired: false, appliesTo: null });
    });
  });

  describe('tasks as gates', () => {
    it('blocks the closing step while tasks are open and unblocks when they are done', async () => {
      const f = await toPreClearance(manager);
      await uploadRequired(f.id);
      for (const s of ['DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION', 'DUTIES_CHARGES', 'CUSTOMS_RELEASE']) await ok(move(manager, f.id, s));
      const task = await ok(api.req('post', '/tasks', officer).send({ clearanceFileId: f.id, title: 'Collect delivery order', dueAt: '2026-12-01T09:00:00Z' }));

      const blocked = await move(manager, f.id, 'DELIVERY_CLOSURE');
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('OPEN_TASKS_REMAIN');
      expect(blocked.body.error.details[0].details).toEqual([expect.objectContaining({ id: task.id, title: 'Collect delivery order' })]);

      await ok(api.req('post', `/tasks/${task.id}/complete`, officer));
      expect((await move(manager, f.id, 'DELIVERY_CLOSURE')).status).toBe(200);
      // cancelled tasks do not block either
      const f2 = await newFile();
      const t2 = await ok(api.req('post', '/tasks', officer).send({ clearanceFileId: f2.id, title: 'Obsolete' }));
      await ok(api.req('patch', `/tasks/${t2.id}`, officer).send({ status: 'CANCELLED' }));
      expect((await ok(api.req('get', `/clearance-files/${f2.id}/closure-check`, A))).blockers.some((b: any) => b.code === 'OPEN_TASKS_REMAIN')).toBe(false);
    });
  });

  describe('approvals and configurable rules', () => {
    it('requires approval permission where a transition is configured that way', async () => {
      const tpl = (await ok(api.req('get', '/workflow-templates?fileType=IMPORT', A)))[0];
      const dutiesToRelease = tpl.transitions.find((t: any) => {
        const from = tpl.stages.find((s: any) => s.id === t.fromStageId);
        const to = tpl.stages.find((s: any) => s.id === t.toStageId);
        return from.code === 'DUTIES_CHARGES' && to.code === 'CUSTOMS_RELEASE';
      });
      const upd = await api.req('patch', `/workflow-templates/${tpl.id}/transitions/${dutiesToRelease.id}`, manager).send({ requiresApproval: true });
      expect(upd.body.data.requiresApproval).toBe(true);

      const f = await toPreClearance(manager);
      await uploadRequired(f.id);
      for (const s of ['DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION', 'DUTIES_CHARGES']) await ok(move(officer, f.id, s));
      const blocked = await move(officer, f.id, 'CUSTOMS_RELEASE');
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('APPROVAL_REQUIRED');
      expect((await move(manager, f.id, 'CUSTOMS_RELEASE')).status).toBe(200);

      await api.req('patch', `/workflow-templates/${tpl.id}/transitions/${dutiesToRelease.id}`, manager).send({ requiresApproval: false });
    });
  });

  describe('closing and reopening', () => {
    async function atFinalStage() {
      const f = await toPreClearance(manager);
      await uploadRequired(f.id);
      for (const s of ['DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION', 'DUTIES_CHARGES', 'CUSTOMS_RELEASE', 'DELIVERY_CLOSURE']) await ok(move(manager, f.id, s));
      return f;
    }
    const closeBody = (extra: object = {}) => ({ note: 'All delivered', ...extra });

    it('cannot be closed before the final stage', async () => {
      const f = await toPreClearance();
      const check = await ok(api.req('get', `/clearance-files/${f.id}/closure-check`, A));
      expect(check).toMatchObject({ canClose: false });
      expect(check.blockers[0].code).toBe('NOT_AT_TERMINAL_STAGE');
      const res = await api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('NOT_AT_TERMINAL_STAGE');
    });

    it('closes a finished file, then treats it as read-only', async () => {
      const f = await atFinalStage();
      expect((await api.req('post', `/clearance-files/${f.id}/close`, officer).send(closeBody())).status).toBe(403);
      const closed = await ok(api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody()));
      expect(closed.status).toBe('CLOSED');
      expect(closed.closedAt).not.toBeNull();
      const again = await api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody());
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('FILE_NOT_ACTIVE');
      expect((await api.req('patch', `/clearance-files/${f.id}`, A).send({ priority: 'LOW' })).body.error.code).toBe('FILE_NOT_EDITABLE');
      const move2 = await move(manager, f.id, 'CUSTOMS_RELEASE', 'try to go back');
      expect(move2.status).toBe(409);
      expect(move2.body.error.code).toBe('FILE_NOT_ACTIVE');
      const tl = await ok(api.req('get', `/clearance-files/${f.id}/timeline`, A));
      expect(tl[0]).toMatchObject({ activityType: 'FILE_CLOSED' });
      expect((await ok(api.req('get', `/clearance-files?status=CLOSED&limit=100`, A))).some((x: any) => x.id === f.id)).toBe(true);
    });

    it('blocks closing with draft invoices and asks for acknowledgement when money is outstanding', async () => {
      const f = await atFinalStage();
      const mk = (invoiceNumber: string, status: 'DRAFT' | 'ISSUED') => api.prisma.invoice.create({
        data: {
          tenantId: tenantAId, clearanceFileId: f.id, clientId, invoiceNumber, currencyCode: 'USD', subtotal: '500.0000',
          totalAmount: '500.0000', status, issueDate: new Date(), createdBy: ownerId,
        },
      });
      const draft = await mk(`INV-D-${f.fileNumber}`, 'DRAFT');
      const blocked = await api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody());
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('DRAFT_INVOICES_EXIST');

      await api.prisma.invoice.update({ where: { id: draft.id }, data: { status: 'ISSUED', issuedAt: new Date() } });
      const check = await ok(api.req('get', `/clearance-files/${f.id}/closure-check`, A));
      expect(check.canClose).toBe(true); // a warning, not a blocker
      expect(check.warnings[0]).toMatchObject({ code: 'OUTSTANDING_BALANCE' });
      expect(check.warnings[0].details[0]).toMatchObject({ currency: 'USD', total: '500.0000', paid: '0.0000', outstanding: '500.0000' });

      const noAck = await api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody());
      expect(noAck.status).toBe(409);
      expect(noAck.body.error.code).toBe('OUTSTANDING_BALANCE');

      // a partial payment reduces the outstanding amount shown
      const cash = await api.prisma.cashAccount.findFirstOrThrow({ where: { tenantId: tenantAId, currencyCode: 'USD' } });
      const pay = await api.prisma.payment.create({
        data: {
          tenantId: tenantAId, clientId, paymentNumber: `PAY-${f.fileNumber}`, paymentType: 'CLIENT_PAYMENT', amount: '200.0000', currencyCode: 'USD',
          exchangeRate: '1.0000000000', baseAmount: '200.0000', paymentMethod: 'CASH', cashAccountId: cash.id, paymentDate: new Date(), receivedBy: ownerId, status: 'POSTED',
        },
      });
      await api.prisma.paymentAllocation.create({ data: { tenantId: tenantAId, paymentId: pay.id, invoiceId: draft.id, allocatedAmount: '200.0000', currencyCode: 'USD' } });
      expect((await ok(api.req('get', `/clearance-files/${f.id}/closure-check`, A))).warnings[0].details[0].outstanding).toBe('300.0000');

      const closed = await ok(api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody({ acknowledgeOutstanding: true })));
      expect(closed.status).toBe('CLOSED');
      const audit = await api.prisma.auditLog.findFirstOrThrow({ where: { action: 'CLEARANCE_FILE_CLOSED', entityId: f.id } });
      expect(JSON.stringify(audit.afterData)).toContain('300.0000'); // the acknowledged balance is on record
    });

    it('reopens to the previous stage with a mandatory reason', async () => {
      const f = await atFinalStage();
      await ok(api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody()));
      expect((await api.req('post', `/clearance-files/${f.id}/reopen`, officer).send({ reason: 'customer dispute' })).status).toBe(403);
      expect((await api.req('post', `/clearance-files/${f.id}/reopen`, manager).send({ reason: 'x' })).status).toBe(400);
      expect((await api.req('post', `/clearance-files/${f.id}/reopen`, manager).send({})).status).toBe(400);
      const reopened = await ok(api.req('post', `/clearance-files/${f.id}/reopen`, manager).send({ reason: 'Customs asked for a correction' }));
      expect(reopened).toMatchObject({ status: 'OPEN', closedAt: null });
      expect(reopened.currentStage.code).toBe('CUSTOMS_RELEASE');
      const history = await ok(api.req('get', `/clearance-files/${f.id}/status-history`, A));
      expect(history.at(-1)).toMatchObject({ reason: 'Reopened: Customs asked for a correction' });
      expect((await api.req('patch', `/clearance-files/${f.id}`, A).send({ priority: 'LOW' })).status).toBe(200); // editable again
      expect((await api.req('post', `/clearance-files/${f.id}/reopen`, manager).send({ reason: 'again please' })).body.error.code).toBe('FILE_NOT_CLOSED');
      // and it can be moved forward and closed a second time
      await ok(move(manager, f.id, 'DELIVERY_CLOSURE'));
      expect((await api.req('post', `/clearance-files/${f.id}/close`, manager).send(closeBody())).status).toBe(200);
    });
  });

  describe('configuring workflows', () => {
    let tplId: string;
    let s: Record<string, string>;

    it('lists templates with stages and transitions, in bilingual form', async () => {
      const all = await ok(api.req('get', '/workflow-templates', viewer));
      expect(all.map((t: any) => t.fileType).sort()).toEqual(['EXPORT', 'IMPORT', 'OTHER']);
      const imp = all.find((t: any) => t.fileType === 'IMPORT');
      expect(imp.stages).toHaveLength(8);
      expect(imp.stages[0]).toMatchObject({ code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد', sequence: 1 });
      expect(imp.transitions.length).toBe(13); // 7 forward + 6 backward (none out of the terminal stage)
    });

    it('builds a new template step by step, validating every rule', async () => {
      const created = await api.req('post', '/workflow-templates', manager).send({ name: 'Express import', fileType: 'IMPORT', description: 'Fast track' });
      expect(created.status).toBe(201);
      tplId = created.body.data.id;
      expect(created.body.data.isActive).toBe(false); // never live until activated deliberately

      expect((await api.req('patch', `/workflow-templates/${tplId}`, manager).send({ isActive: true })).body.error.code).toBe('TEMPLATE_HAS_NO_STAGES');
      const stage = (code: string, extra: object = {}) =>
        api.req('post', `/workflow-templates/${tplId}/stages`, manager).send({ code, nameEn: code, nameAr: `${code}-ar`, ...extra });
      s = {};
      s.OPENED = (await ok(stage('OPENED'))).id;
      s.CLEARED = (await ok(stage('CLEARED'))).id;
      s.DONE = (await ok(stage('DONE', { isTerminal: true }))).id;
      expect((await stage('OPENED')).body.error.code).toBe('STAGE_CODE_TAKEN');
      expect((await stage('EXTRA', { sequence: 1 })).body.error.code).toBe('STAGE_SEQUENCE_TAKEN');
      expect((await stage('bad code!')).status).toBe(400);
      const tpl = await ok(api.req('get', `/workflow-templates/${tplId}`, manager));
      expect(tpl.stages.map((x: any) => [x.code, x.sequence])).toEqual([['OPENED', 1], ['CLEARED', 2], ['DONE', 3]]);

      const tr = (from: string, to: string, extra: object = {}) =>
        api.req('post', `/workflow-templates/${tplId}/transitions`, manager).send({ fromStageId: s[from], toStageId: s[to], ...extra });
      expect((await tr('OPENED', 'CLEARED', { requiresDocumentCheck: true, requiredPermission: 'clearance_files.transition' })).status).toBe(201);
      expect((await tr('CLEARED', 'DONE', { requiredPermission: 'clearance_files.close', requiresReason: true })).status).toBe(201);
      expect((await tr('OPENED', 'CLEARED')).body.error.code).toBe('TRANSITION_EXISTS');
      expect((await tr('OPENED', 'OPENED')).body.error.code).toBe('TRANSITION_TO_SELF');
      expect((await tr('DONE', 'OPENED')).body.error.code).toBe('TRANSITION_FROM_TERMINAL');
      expect((await tr('OPENED', 'DONE', { requiredPermission: 'made.up' })).body.error.code).toBe('UNKNOWN_PERMISSION');
      const otherTpl = (await ok(api.req('get', '/workflow-templates?fileType=EXPORT', A)))[0];
      const foreign = await api.req('post', `/workflow-templates/${tplId}/transitions`, manager).send({ fromStageId: s.OPENED, toStageId: otherTpl.stages[1].id });
      expect(foreign.body.error.code).toBe('STAGE_NOT_IN_TEMPLATE');
      expect((await api.req('patch', `/workflow-templates/${tplId}/stages/${s.CLEARED}`, manager).send({ isTerminal: true })).body.error.code).toBe('STAGE_HAS_TRANSITIONS');
    });

    it('activating a template replaces the active one for new files only', async () => {
      const oldFile = await newFile(); // created with the standard template
      const act = await ok(api.req('patch', `/workflow-templates/${tplId}`, manager).send({ isActive: true }));
      expect(act.isActive).toBe(true);
      const all = await ok(api.req('get', '/workflow-templates?fileType=IMPORT', A));
      expect(all.filter((t: any) => t.isActive).map((t: any) => t.name)).toEqual(['Express import']);

      const fresh = await newFile();
      expect(fresh.workflowTemplate.name).toBe('Express import');
      expect(fresh.currentStage.code).toBe('OPENED');
      // the file created earlier keeps its original workflow
      const old = await ok(api.req('get', `/clearance-files/${oldFile.id}`, A));
      expect(old.workflowTemplate.name).toBe('Standard import clearance');
      expect((await move(officer, old.id, 'DOCUMENT_COLLECTION')).status).toBe(200);

      // the new workflow's own transitions apply
      const toCleared = await move(officer, fresh.id, 'CLEARED');
      expect(toCleared.status).toBe(200); // the transition asks for a document check, but no requirement names this stage
    });

    it('applies the configured document check once a requirement names a stage of the new template', async () => {
      const req = await ok(api.req('post', '/document-requirements', manager).send({
        fileType: 'IMPORT', documentTypeId: types.PAYMENT_PROOF, isRequired: true, isRequiredBeforeStageId: s.CLEARED,
      }));
      const f = await newFile();
      expect(f.currentStage.code).toBe('OPENED');
      const blocked = await move(officer, f.id, 'CLEARED');
      expect(blocked.status).toBe(422);
      expect(blocked.body.error.code).toBe('REQUIRED_DOCUMENTS_MISSING');
      expect(blocked.body.error.details[0].details.map((d: any) => d.code)).toEqual(['PAYMENT_PROOF']);
      await ok(addDoc(officer, f.id, 'PAYMENT_PROOF'));
      expect((await move(officer, f.id, 'CLEARED')).status).toBe(200);
      await api.req('delete', `/document-requirements/${req.id}`, manager);
    });

    it('applies the permission and reason rules configured on the final transition', async () => {
      const f = await newFile();
      await ok(move(officer, f.id, 'CLEARED'));
      const noPerm = await move(officer, f.id, 'DONE', 'finished');
      expect(noPerm.status).toBe(403);
      expect(noPerm.body.error.code).toBe('PERMISSION_DENIED'); // this transition needs clearance_files.close
      const noReason = await move(manager, f.id, 'DONE');
      expect(noReason.status).toBe(422);
      expect(noReason.body.error.code).toBe('REASON_REQUIRED');
      expect((await move(manager, f.id, 'DONE', 'Finished early')).status).toBe(200);
    });

    it('can change rules and remove transitions', async () => {
      const tpl = await ok(api.req('get', `/workflow-templates/${tplId}`, manager));
      const clearedToDone = tpl.transitions.find((t: any) => t.fromStageId === s.CLEARED);
      const upd = await ok(api.req('patch', `/workflow-templates/${tplId}/transitions/${clearedToDone.id}`, manager).send({ requiresReason: false, requiredPermission: null }));
      expect(upd).toMatchObject({ requiresReason: false, requiredPermission: null });
      expect((await api.req('patch', `/workflow-templates/${tplId}/transitions/${clearedToDone.id}`, manager).send({ requiredPermission: 'nope.nope' })).body.error.code).toBe('UNKNOWN_PERMISSION');
      expect((await api.req('delete', `/workflow-templates/${tplId}/transitions/${clearedToDone.id}`, manager)).status).toBe(204);
      expect((await ok(api.req('get', `/workflow-templates/${tplId}`, manager))).transitions).toHaveLength(1);
      expect((await api.req('patch', `/workflow-templates/${tplId}/stages/${s.DONE}`, manager).send({ nameEn: 'Finished', nameAr: 'منتهي' })).status).toBe(200);
      // switch back so later tests use the standard workflow
      const std = (await ok(api.req('get', '/workflow-templates?fileType=IMPORT', A))).find((t: any) => t.name === 'Standard import clearance');
      await ok(api.req('patch', `/workflow-templates/${std.id}`, manager).send({ isActive: true }));
    });

    it('requires workflows.manage and never exposes templates across offices', async () => {
      expect((await api.req('post', '/workflow-templates', officer).send({ name: 'Nope', fileType: 'IMPORT' })).status).toBe(403);
      expect((await api.req('patch', `/workflow-templates/${tplId}`, officer).send({ isActive: false })).status).toBe(403);
      expect((await api.req('post', `/workflow-templates/${tplId}/stages`, officer).send({ code: 'NOPE', nameEn: 'x', nameAr: 'x' })).status).toBe(403);
      // office B cannot see or touch A's template
      expect((await api.req('get', `/workflow-templates/${tplId}`, B)).status).toBe(404);
      expect((await api.req('patch', `/workflow-templates/${tplId}`, B).send({ name: 'hacked' })).status).toBe(404);
      expect((await api.req('post', `/workflow-templates/${tplId}/stages`, B).send({ code: 'EVIL', nameEn: 'x', nameAr: 'x' })).status).toBe(404);
      expect((await ok(api.req('get', '/workflow-templates', B))).every((t: any) => t.id !== tplId)).toBe(true);
      expect((await ok(api.req('get', '/workflow-templates', B))).map((t: any) => t.name)).not.toContain('Express import');
    });
  });

  describe('office isolation', () => {
    it('answers 404 for every workflow route on another office\'s file', async () => {
      const f = await newFile();
      const calls: [Parameters<TestApi['req']>[0], string, object?][] = [
        ['get', `/clearance-files/${f.id}/transitions`], ['post', `/clearance-files/${f.id}/transition`, { toStageCode: 'DOCUMENT_COLLECTION' }],
        ['get', `/clearance-files/${f.id}/status-history`], ['get', `/clearance-files/${f.id}/closure-check`],
        ['post', `/clearance-files/${f.id}/close`, {}], ['post', `/clearance-files/${f.id}/reopen`, { reason: 'because' }],
      ];
      for (const [method, path, body] of calls) {
        const res = await api.req(method, path, B).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
      expect(await stageOf(f.id)).toBe('NEW_FILE');
    });
  });
});
