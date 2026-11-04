import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iso6346CheckDigit } from '../src/common/iso6346';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';
import { ok, trialBalance } from './finance-helpers';

const YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Beirut', year: 'numeric' }).format(new Date());
const pdf = (t: string) => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);

/**
 * The MVP acceptance scenario (specification section 20), driven ONLY through the HTTP API:
 *
 *  1 create a customs office            9 move the file through its workflow
 *  2 create an admin and two employees  10 record a USD 500 client advance
 *  3 create a client                    11 record clearance expenses
 *  4 create an import clearance file    12 generate the client invoice
 *  5 its unique file number             13 record the final payment and allocate it
 *  6 add a vessel, BL and container     14 close the file
 *  7 upload invoice and packing list    15 show the operational history and profitability
 *  8 assign the file to an employee
 */
describe('MVP end-to-end scenario (spec section 20)', () => {
  let api: TestApi;
  let admin: string; let officer: string; let accountant: string;
  let officerId: string;
  let clientId: string; let fileId: string; let fileNumber: string; let shipmentId: string;
  let invoiceId: string;
  const CONTAINER = `MSKU123456${iso6346CheckDigit('MSKU123456')}`;
  const ids: Record<string, string> = {};

  const move = (token: string, to: string, reason?: string) => api.req('post', `/clearance-files/${fileId}/transition`, token).send({ toStageCode: to, reason });
  const upload = (code: string, name: string) => api.req('post', `/clearance-files/${fileId}/documents`, officer).field('documentTypeId', ids[code]).attach('file', pdf(code), name);

  beforeAll(async () => { api = await startApi(); });
  afterAll(async () => api.close());

  it('1-2. creates the office, an administrator and two employees', async () => {
    const office = await provision(api, 'lifecycle', 'owner@lifecycle.test');
    expect(office.slug).toBe('lifecycle');
    const owner = (await signIn(api, 'owner@lifecycle.test')).accessToken;
    await createUser(api, owner, 'admin@lifecycle.test', 'ADMIN');
    officerId = (await createUser(api, owner, 'officer@lifecycle.test', 'CLEARANCE_OFFICER')).id;
    await createUser(api, owner, 'accountant@lifecycle.test', 'ACCOUNTANT');
    admin = (await signIn(api, 'admin@lifecycle.test')).accessToken;
    officer = (await signIn(api, 'officer@lifecycle.test')).accessToken;
    accountant = (await signIn(api, 'accountant@lifecycle.test')).accessToken;
    const users = await ok(api.req('get', '/users', admin));
    expect(users.map((u: any) => u.email).sort()).toEqual(['accountant@lifecycle.test', 'admin@lifecycle.test', 'officer@lifecycle.test', 'owner@lifecycle.test']);
    const types = await ok(api.req('get', '/document-types', officer));
    for (const t of types) ids[t.code] = t.id;
  });

  it('3. creates a client', async () => {
    const c = await ok(api.req('post', '/clients', admin).send({ name: 'Al-Amin Trading', clientType: 'COMPANY', countryCode: 'lb', paymentTermsDays: 30, contacts: [{ name: 'Rami Khoury', phone: '+961 3 000000' }] }));
    clientId = c.id;
    expect(c).toMatchObject({ clientCode: 'CLT-00001', countryCode: 'LB', isActive: true });
  });

  it('4-5. creates an import clearance file with its unique, correctly sequenced number', async () => {
    const f = await ok(api.req('post', '/clearance-files', officer).send({ fileType: 'IMPORT', clientId, priority: 'HIGH', expectedArrivalAt: '2026-11-15T10:00:00Z', internalNotes: 'First shipment for this client' }));
    fileId = f.id;
    fileNumber = f.fileNumber;
    expect(fileNumber).toBe(`IMP-${YEAR}-00001`);
    expect(f).toMatchObject({ status: 'OPEN', currentStage: { code: 'NEW_FILE' }, workflowTemplate: { name: 'Standard import clearance' } });
    const second = await ok(api.req('post', '/clearance-files', officer).send({ fileType: 'IMPORT', clientId }));
    expect(second.fileNumber).toBe(`IMP-${YEAR}-00002`); // sequential, no gaps
  });

  it('6. adds a vessel, bill of lading and container', async () => {
    const s = await ok(api.req('post', `/clearance-files/${fileId}/shipments`, officer).send({
      vesselName: 'MSC Aurora', voyageNumber: 'V042E', billOfLadingNumber: 'MEDU-778899', etd: '2026-11-01T00:00:00Z', eta: '2026-11-15T08:00:00Z',
    }));
    shipmentId = s.id;
    const c = await ok(api.req('post', `/shipments/${shipmentId}/containers`, officer).send({ containerNumber: CONTAINER.toLowerCase(), containerType: '40HC', grossWeight: 24500, netWeight: 23800, packageCount: 900 }));
    expect(c.containerNumber).toBe(CONTAINER);
    await ok(api.req('post', `/shipments/${shipmentId}/goods`, officer).send({ description: 'Ceramic tiles 60x60', quantity: 1200, unitOfMeasure: 'M2', unitPrice: '8.75', currencyCode: 'USD', countryOfOrigin: 'TR' }));
    const search = await ok(api.req('get', `/clearance-files?search=${CONTAINER}`, officer)); // findable by container number
    expect(search.map((x: any) => x.id)).toEqual([fileId]);
  });

  it('7. uploads the commercial invoice and packing list (and the bill of lading)', async () => {
    const docs = [await upload('COMMERCIAL_INVOICE', 'invoice.pdf'), await upload('PACKING_LIST', 'packing-list.pdf'), await upload('BILL_OF_LADING', 'bl.pdf')];
    for (const d of docs) expect(d.status).toBe(201);
    const checklist = await ok(api.req('get', `/clearance-files/${fileId}/document-requirements`, officer));
    expect(checklist.filter((c: any) => c.isRequired).every((c: any) => c.satisfied)).toBe(true);
  });

  it('8. assigns the file to an employee', async () => {
    const f = await ok(api.req('post', `/clearance-files/${fileId}/assign`, admin).send({ userId: officerId }));
    expect(f.assignee.id).toBe(officerId);
  });

  it('9. moves the file through its configured workflow', async () => {
    for (const stage of ['DOCUMENT_COLLECTION', 'PRE_CLEARANCE', 'DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION', 'DUTIES_CHARGES', 'CUSTOMS_RELEASE']) {
      const r = await move(officer, stage);
      expect(r.status, stage).toBe(200);
    }
    // an officer cannot take the final step; an administrator can
    expect((await move(officer, 'DELIVERY_CLOSURE')).status).toBe(403);
    const final = await move(admin, 'DELIVERY_CLOSURE');
    expect(final.status).toBe(200);
    expect(final.body.data.currentStage.code).toBe('DELIVERY_CLOSURE');
  });

  it('10. records a USD 500 client advance (held as a liability, not revenue)', async () => {
    const cash = (await ok(api.req('get', '/cash-accounts', accountant))).find((c: any) => c.currencyCode === 'USD');
    ids.usdCash = cash.id;
    const p = await ok(api.req('post', '/payments', accountant).send({
      clientId, clearanceFileId: fileId, paymentType: 'CLIENT_ADVANCE', amount: '500', currencyCode: 'USD', cashAccountId: cash.id,
      paymentMethod: 'BANK_TRANSFER', referenceNumber: 'WIRE-2211', paymentDate: '2026-11-10',
    }));
    ids.advance = p.id;
    expect(p).toMatchObject({ status: 'POSTED', unallocatedAmount: '500.0000' });
    const t = await trialBalance(api, accountant);
    expect(t.balance('2100')).toBe('500.0000'); // owed back to the client until applied
    expect(t.balance('4100')).toBe('0.0000'); // and NOT revenue
  });

  it('11. records the clearance expenses', async () => {
    const cats = Object.fromEntries((await ok(api.req('get', '/financial-categories', accountant))).map((c: any) => [c.name, c.id]));
    const record = async (category: string, description: string, amount: string) => {
      const e = await ok(api.req('post', '/expenses', officer).send({ categoryId: cats[category], clearanceFileId: fileId, description, amount, currencyCode: 'USD', expenseDate: '2026-11-12' }));
      await ok(api.req('post', `/expenses/${e.id}/approve`, accountant).send({ cashAccountId: ids.usdCash }));
      return e.id as string;
    };
    ids.duty = await record('Customs duties and taxes', 'Customs duty', '800');
    ids.port = await record('Port fees', 'Port handling', '150');
    ids.transport = await record('Transportation', 'Truck to warehouse', '100');
    ids.cats = JSON.stringify(cats);
    const t = await trialBalance(api, accountant);
    expect(t.balance('1300')).toBe('1050.0000'); // paid for the client, to be re-billed
    expect(t.balance('5100')).toBe('0.0000'); // none of it is the office's own cost
  });

  it('12. generates the client invoice, re-billing the expenses at cost plus the service fee', async () => {
    const cats = JSON.parse(ids.cats);
    const draft = await ok(api.req('post', '/invoices', accountant).send({
      clearanceFileId: fileId, invoiceType: 'FINAL',
      items: [{ description: 'Customs clearance service', categoryId: cats['Clearance service fees'], unitPrice: '400' }, { expenseId: ids.duty }, { expenseId: ids.port }, { expenseId: ids.transport }],
    }));
    expect(draft).toMatchObject({ status: 'DRAFT', totalAmount: '1450.0000' });
    const inv = await ok(api.req('post', `/invoices/${draft.id}/issue`, accountant).send({ issueDate: '2026-11-14' }));
    invoiceId = inv.id;
    expect(inv.invoiceNumber).toBe(`INV-2026-00001`);
    expect(inv).toMatchObject({ status: 'ISSUED', totalAmount: '1450.0000', paymentStatus: 'UNPAID', outstandingAmount: '1450.0000' });
    const t = await trialBalance(api, accountant);
    expect(t.balance('1200')).toBe('1450.0000');
    expect(t.balance('4100')).toBe('400.0000'); // revenue is ONLY the service fee
    expect(t.balance('1300')).toBe('0.0000'); // disbursements are recovered, not income
  });

  it('13. records the final payment and allocates it, together with the advance', async () => {
    const final = await ok(api.req('post', '/payments', accountant).send({
      clientId, clearanceFileId: fileId, paymentType: 'CLIENT_PAYMENT', amount: '950', currencyCode: 'USD', cashAccountId: ids.usdCash,
      paymentMethod: 'CASH', paymentDate: '2026-11-16', allocations: [{ invoiceId, amount: '950' }],
    }));
    expect(final.unallocatedAmount).toBe('0.0000');
    await ok(api.req('post', `/payments/${ids.advance}/allocate`, accountant).send({ allocations: [{ invoiceId, amount: '500' }] }));
    const inv = await ok(api.req('get', `/invoices/${invoiceId}`, accountant));
    expect(inv).toMatchObject({ paymentStatus: 'PAID', paidAmount: '1450.0000', outstandingAmount: '0.0000' });
    expect(inv.allocations).toHaveLength(2);
    const t = await trialBalance(api, accountant);
    expect(t.balance('1200')).toBe('0.0000'); // nothing owed
    expect(t.balance('2100')).toBe('0.0000'); // advance fully applied
    expect((await ok(api.req('get', `/clients/${clientId}/balance`, accountant))).balances[0]).toMatchObject({ outstanding: '0.0000', unappliedCredit: '0.0000', netBalance: '0.0000' });
  });

  it('14. closes the file after the operational and financial checks', async () => {
    const check = await ok(api.req('get', `/clearance-files/${fileId}/closure-check`, admin));
    expect(check).toMatchObject({ canClose: true, blockers: [], warnings: [] });
    const closed = await ok(api.req('post', `/clearance-files/${fileId}/close`, admin).send({ note: 'Delivered to consignee' }));
    expect(closed).toMatchObject({ status: 'CLOSED' });
    expect(closed.closedAt).not.toBeNull();
    expect((await api.req('patch', `/clearance-files/${fileId}`, admin).send({ priority: 'LOW' })).body.error.code).toBe('FILE_NOT_EDITABLE');
  });

  it('15. shows the file\'s operational history and its financial profitability', async () => {
    const timeline = await ok(api.req('get', `/clearance-files/${fileId}/timeline?limit=100`, admin));
    const kinds = new Set(timeline.map((t: any) => t.activityType));
    for (const k of ['FILE_CREATED', 'SHIPMENT_ADDED', 'CONTAINER_ADDED', 'DOCUMENT_UPLOADED', 'EMPLOYEE_ASSIGNED', 'STAGE_CHANGED', 'PAYMENT_RECEIVED', 'EXPENSE_APPROVED', 'INVOICE_ISSUED', 'PAYMENT_ALLOCATED', 'FILE_CLOSED']) {
      expect(kinds.has(k), k).toBe(true);
    }
    const history = await ok(api.req('get', `/clearance-files/${fileId}/status-history`, admin));
    expect(history.map((h: any) => h.toStage.code)).toEqual([
      'NEW_FILE', 'DOCUMENT_COLLECTION', 'PRE_CLEARANCE', 'DECLARATION_SUBMITTED', 'ASSESSMENT_INSPECTION', 'DUTIES_CHARGES', 'CUSTOMS_RELEASE', 'DELIVERY_CLOSURE',
    ]);

    const costs = await ok(api.req('get', `/clearance-files/${fileId}/costs`, accountant));
    expect(costs.profitability).toMatchObject({ serviceRevenue: '400.0000', officeCosts: '0.0000', profit: '400.0000', marginPercent: '100.00' });
    expect(costs.passThrough).toMatchObject({ disbursed: '1050.0000', reBilled: '1050.0000', unrecovered: '0.0000' });
    expect(costs.invoices).toMatchObject({ count: 1, invoicedByCurrency: { USD: '1450.0000' }, paidByCurrency: { USD: '1450.0000' }, outstandingByCurrency: { USD: '0.0000' } });

    const profit = await ok(api.req('get', '/reports/profitability', accountant));
    expect(profit.find((r: any) => r.id === fileId)).toMatchObject({ fileNumber, profit: '400.0000' });
  });

  it('leaves the books balanced and every report in agreement', async () => {
    const t = await trialBalance(api, accountant);
    expect(t.balanced).toBe(true);
    const summary = await ok(api.req('get', '/reports/financial-summary', accountant));
    expect(summary.results).toMatchObject({ serviceRevenue: '400.0000', officeExpenses: '0.0000', operatingResult: '400.0000', fxGainLoss: '0.0000' });
    expect(summary.position).toMatchObject({ receivables: '0.0000', clientAdvancesHeld: '0.0000', unrecoveredDisbursements: '0.0000', payables: '0.0000' });
    // cash: +500 advance +950 final payment -1,050 expenses = 400 = exactly the profit the office earned
    const cash = (await ok(api.req('get', '/cash-accounts', accountant))).find((c: any) => c.id === ids.usdCash);
    expect(cash.balance).toBe('400.0000');
    expect(summary.position.cashAndBankBase).toBe('400.0000');
    // and an audit trail exists for the money movements
    const actions = (await api.prisma.auditLog.findMany({ where: { entityType: { in: ['Payment', 'Invoice', 'Expense', 'PaymentAllocation'] } } })).map((l) => l.action);
    for (const a of ['PAYMENT_RECEIVED', 'EXPENSE_APPROVED', 'INVOICE_ISSUED', 'PAYMENT_ALLOCATED']) expect(actions).toContain(a);
  });
});
