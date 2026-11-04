import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, type FinanceOffice } from './finance-helpers';

const DAY = 86_400_000;
const pdf = (t: string) => Buffer.from(`%PDF-1.4\n% ${t}\n%%EOF\n`);
function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}

describe('dashboard, operational reports and export', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;
  let officerId: string;
  let client2: string;
  const F: Record<string, string> = {};

  const fee = (amount: string) => ({ description: 'Clearance fee', categoryId: A.cat[CAT.SERVICE], unitPrice: amount });
  const invoice = async (fileId: string, amount: string, o: { currency?: string; issueDate?: string; dueDate?: string } = {}) => {
    const d = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: fileId, currencyCode: o.currency ?? 'USD', items: [fee(amount)] }));
    return ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: o.issueDate ?? '2026-11-05', ...(o.dueDate && { dueDate: o.dueDate }) })) as Promise<any>;
  };
  const get = (path: string, token = A.accountant) => api.req('get', path, token);
  const rows = async (path: string, token = A.accountant) => (await ok(get(path, token))) as any[];

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'ops-a');
    B = await financeOffice(api, 'ops-b');
    officerId = (await ok(api.req('get', '/users', A.owner))).find((u: any) => u.email.startsWith('officer')).id;
    client2 = (await ok(api.req('post', '/clients', A.owner).send({ name: 'Second Client' }))).id;

    // F1: open import, HIGH priority, assigned, arrival date already passed and nothing has arrived
    F.f1 = A.fileId;
    await ok(api.req('patch', `/clearance-files/${F.f1}`, A.owner).send({ priority: 'HIGH', expectedArrivalAt: new Date(Date.now() - 3 * DAY).toISOString() }));
    await ok(api.req('post', `/clearance-files/${F.f1}/assign`, A.owner).send({ userId: officerId }));
    // (resolve the type id first: building one request while awaiting another would close supertest's shared server)
    const invoiceTypeId = (await ok(api.req('get', '/document-types', A.owner))).find((t: any) => t.code === 'COMMERCIAL_INVOICE').id;
    await ok(api.req('post', `/clearance-files/${F.f1}/documents`, A.officer).field('documentTypeId', invoiceTypeId).attach('file', pdf('ci'), 'ci.pdf'));

    // F2: open export, unassigned, arriving in 3 days
    F.f2 = (await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'EXPORT', clientId: client2, expectedArrivalAt: new Date(Date.now() + 3 * DAY).toISOString() }))).id;

    // F3: closed 5 days after opening
    F.f3 = await A.newFile();

    // F4: quiet for 20 days
    F.f4 = await A.newFile();
    await api.prisma.fileActivity.updateMany({ where: { clearanceFileId: F.f4 }, data: { createdAt: new Date(Date.now() - 20 * DAY) } });

    // money: F1 USD invoice 1000 (overdue, unpaid), F2/client2 LBP invoice 89.5M, F3 USD invoice 300 settled
    await invoice(F.f1, '1000', { issueDate: '2026-10-15', dueDate: '2026-10-30' });
    await invoice(F.f2, '89500000', { currency: 'LBP', issueDate: '2026-11-05' });
    const i3 = await invoice(F.f3, '300', { issueDate: '2026-11-06' });
    const p = await ok(api.req('post', '/payments', A.accountant).send({ clientId: A.clientId, paymentType: 'CLIENT_PAYMENT', amount: '300', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH', paymentDate: '2026-11-07', allocations: [{ invoiceId: i3.id, amount: '300' }] }));
    await ok(api.req('post', '/payments', A.accountant).send({ clientId: client2, paymentType: 'CLIENT_ADVANCE', amount: '150', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH', paymentDate: '2026-11-07' }));
    void p;
    // F3 is closed only after its money has been recorded (a closed file is read-only)
    const opened = new Date(Date.now() - 20 * DAY);
    await api.prisma.clearanceFile.update({ where: { id: F.f3 }, data: { status: 'CLOSED', openedAt: opened, closedAt: new Date(opened.getTime() + 5 * DAY), assignedTo: officerId } });
    // expenses: a pass-through port fee (paid) and an office cost on F1, in two categories and vendors
    const vendor = (await ok(api.req('post', '/parties', A.owner).send({ name: 'Port Authority', partyType: 'OTHER' }))).id;
    ids.vendor = vendor;
    for (const [cat, amount, desc] of [[CAT.PORT, '200', 'Port fee'], [CAT.OFFICE, '50', 'Stationery']] as const) {
      const e = await ok(api.req('post', '/expenses', A.officer).send({ categoryId: A.cat[cat], clearanceFileId: F.f1, vendorId: vendor, description: desc, amount, currencyCode: 'USD', expenseDate: '2026-11-03' }));
      await ok(api.req('post', `/expenses/${e.id}/approve`, A.accountant).send({ cashAccountId: A.cash.usd }));
    }
    // tasks: one overdue open, one done on time, one done late
    const task = (body: object) => ok(api.req('post', '/tasks', A.owner).send({ assignedTo: officerId, ...body }));
    await task({ title: 'Overdue', dueAt: new Date(Date.now() - 2 * DAY).toISOString() });
    const ontime = await task({ title: 'On time', dueAt: new Date(Date.now() + 2 * DAY).toISOString() });
    await ok(api.req('post', `/tasks/${ontime.id}/complete`, A.officer));
    const late = await task({ title: 'Late', dueAt: new Date(Date.now() - 4 * DAY).toISOString() });
    await ok(api.req('post', `/tasks/${late.id}/complete`, A.officer));
  });
  afterAll(async () => api.close());
  const ids: Record<string, string> = {};

  describe('clearance-files report', () => {
    it('lists files with bilingual columns, report-wide counts and the average time to close', async () => {
      const res = await get('/reports/clearance-files?limit=100');
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(4);
      expect(res.body.meta).toMatchObject({ report: 'clearance-files', total: 4, basis: 'COUNTS', byStatus: { OPEN: 3, CLOSED: 1 }, byType: { IMPORT: 3, EXPORT: 1 }, averageDaysToClose: 5 });
      expect(res.body.meta.columns.find((c: any) => c.key === 'fileNumber').header).toEqual({ en: 'File number', ar: 'رقم الملف' });
      const closed = res.body.data.find((r: any) => r.status === 'CLOSED');
      expect(closed.daysOpen).toBe(5);
      const f1 = res.body.data.find((r: any) => r.priority === 'HIGH');
      expect(f1).toMatchObject({ client: `Client of ops-a`, assignee: 'Emp CLEARANCE_OFFICER', stage: 'New file' });
    });

    it('filters by type, status, client, employee, date and search, and pages', async () => {
      expect((await rows('/reports/clearance-files?fileType=EXPORT')).length).toBe(1);
      expect((await rows('/reports/clearance-files?status=CLOSED')).length).toBe(1);
      expect((await rows(`/reports/clearance-files?clientId=${client2}`)).length).toBe(1);
      expect((await rows(`/reports/clearance-files?assignedTo=${officerId}`)).length).toBe(2);
      expect((await rows(`/reports/clearance-files?from=${new Date().toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`)).length).toBe(3); // F3 was opened 20 days ago
      const f1 = (await rows('/reports/clearance-files?limit=100')).find((r) => r.priority === 'HIGH');
      expect((await rows(`/reports/clearance-files?search=${f1.fileNumber}`)).map((r) => r.fileNumber)).toEqual([f1.fileNumber]);
      expect(await rows('/reports/clearance-files?search=%25')).toEqual([]);
      const p = await get('/reports/clearance-files?limit=2&page=2');
      expect(p.body.data).toHaveLength(2);
      expect(p.body.meta.total).toBe(4);
    });

    it('needs reports.view and file access', async () => {
      expect((await get('/reports/clearance-files', A.officer)).status).toBe(403);
      expect((await get('/reports/clearance-files', A.viewer)).status).toBe(200);
      expect((await get('/reports/clearance-files', B.accountant)).body.meta.total).toBe(1); // B's own single file only
    });
  });

  describe('client-balances report', () => {
    it('shows each client per currency in transaction currency, never mixed', async () => {
      const res = await get('/reports/client-balances?limit=100');
      expect(res.body.meta.basis).toBe('TRANSACTION_CURRENCY');
      const byKey = Object.fromEntries(res.body.data.map((r: any) => [`${r.client}|${r.currency}`, r]));
      expect(byKey['Client of ops-a|USD']).toMatchObject({ invoiced: '1300.0000', received: '300.0000', outstanding: '1000.0000', overdue: '1000.0000', unappliedCredit: '0.0000', netBalance: '1000.0000' });
      expect(byKey['Second Client|LBP']).toMatchObject({ invoiced: '89500000.0000', outstanding: '89500000.0000', netBalance: '89500000.0000' });
      expect(byKey['Second Client|USD']).toMatchObject({ received: '150.0000', outstanding: '0.0000', unappliedCredit: '150.0000', netBalance: '-150.0000' }); // advance held for the client
      expect(res.body.meta.totalsByCurrency.outstanding).toEqual({ LBP: '89500000.0000', USD: '1000.0000' });
      expect(res.body.data[0].currency).toBe('LBP'); // largest outstanding first
    });

    it('agrees with the per-client balance endpoint, row for row', async () => {
      for (const [id, name] of [[A.clientId, 'Client of ops-a'], [client2, 'Second Client']] as const) {
        const bal = (await ok(get(`/clients/${id}/balance`))).balances;
        const mine = (await rows('/reports/client-balances?limit=100')).filter((r) => r.client === name);
        for (const b of bal) {
          const r = mine.find((x) => x.currency === b.currency);
          expect(r, `${name} ${b.currency}`).toMatchObject({ invoiced: b.invoiced, received: b.received, outstanding: b.outstanding, unappliedCredit: b.unappliedCredit, netBalance: b.netBalance });
        }
      }
    });

    it('hides clients with nothing open unless asked, and searches', async () => {
      await ok(api.req('post', '/clients', A.owner).send({ name: 'Dormant Client' }));
      expect((await rows('/reports/client-balances?limit=100')).some((r) => r.client === 'Dormant Client')).toBe(false);
      expect((await rows('/reports/client-balances?onlyOpen=false&limit=100')).some((r) => r.client === 'Dormant Client')).toBe(false); // no activity => no currency row at all
      expect((await rows('/reports/client-balances?search=Second')).every((r) => r.client === 'Second Client')).toBe(true);
      expect((await get('/reports/client-balances', A.officer)).status).toBe(403);
    });
  });

  describe('expenses report', () => {
    it('totals in base currency, groups by category and vendor, and keeps transaction currencies separate', async () => {
      const res = await get('/reports/expenses?limit=100');
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toMatchObject({
        basis: 'BASE_CURRENCY', baseCurrency: 'USD', status: 'APPROVED', transactionCurrencyTotals: { USD: '250.0000' },
        byCategory: { [CAT.PORT]: { count: 1, baseTotal: '200.0000' }, [CAT.OFFICE]: { count: 1, baseTotal: '50.0000' } }, byVendor: { 'Port Authority': { count: 2, baseTotal: '250.0000' } },
      });
      expect(res.body.meta.totals.baseAmount).toBe('250.0000');
      expect(res.body.data[0]).toMatchObject({ currency: 'USD', exchangeRate: '1.0000000000', status: 'APPROVED' });
    });

    it('filters by category, vendor, file, dates and status', async () => {
      expect((await rows(`/reports/expenses?categoryId=${A.cat[CAT.PORT]}`)).map((r) => r.description)).toEqual(['Port fee']);
      expect(await rows(`/reports/expenses?clearanceFileId=${F.f2}`)).toEqual([]);
      expect(await rows('/reports/expenses?from=2026-11-04&to=2026-11-30')).toEqual([]);
      expect((await rows('/reports/expenses?from=2026-11-03&to=2026-11-03')).length).toBe(2);
      expect(await rows('/reports/expenses?expenseStatus=DRAFT')).toEqual([]);
      expect((await rows(`/reports/expenses?vendorId=${ids.vendor}`)).length).toBe(2);
    });

    it('needs reports.view and expenses.view', async () => {
      expect((await get('/reports/expenses', A.officer)).status).toBe(403); // can see expenses, but not reports
      expect((await get('/reports/expenses', A.viewer)).status).toBe(200);
    });
  });

  describe('revenue report', () => {
    it('reports service revenue by month from the ledger, with tax and FX beside it', async () => {
      const res = await get('/reports/revenue');
      expect(res.body.meta).toMatchObject({ basis: 'BASE_CURRENCY', groupBy: 'month' });
      const byMonth = Object.fromEntries(res.body.data.map((r: any) => [r.group, r.revenue]));
      expect(byMonth).toEqual({ '2026-10': '1000.0000', '2026-11': '1300.0000' }); // 1000 | 300 + 89.5M LBP at 89,500 = 1000 -> 1300
      expect(res.body.meta.totals.revenue).toBe('2300.0000');
      expect(res.body.data.map((r: any) => r.group)).toEqual(['2026-10', '2026-11']); // chronological
    });

    it('groups by client, filters by client and period, and ignores cancelled invoices', async () => {
      const byClient = await get('/reports/revenue?groupBy=client');
      expect(byClient.body.data.map((r: any) => [r.group, r.revenue])).toEqual([['Client of ops-a', '1300.0000'], ['Second Client', '1000.0000']]);
      expect((await rows(`/reports/revenue?clientId=${client2}`)).map((r) => r.revenue)).toEqual(['1000.0000']);
      expect((await rows('/reports/revenue?from=2026-11-01&to=2026-11-30')).map((r) => r.revenue)).toEqual(['1300.0000']);
      const d = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: F.f1, items: [fee('777')] }));
      const iss = await ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: '2026-11-09' }));
      expect((await rows('/reports/revenue?from=2026-11-09&to=2026-11-09'))[0].revenue).toBe('777.0000');
      await ok(api.req('post', `/invoices/${iss.id}/cancel`, A.accountant).send({ reason: 'wrong client' }));
      // the reversal entry is dated when the invoice was cancelled (today), so over the whole period the 777 nets out
      expect((await get('/reports/revenue')).body.meta.totals.revenue).toBe('2300.0000');
    });

    it('needs reports.view', async () => {
      expect((await get('/reports/revenue', A.officer)).status).toBe(403);
      expect((await get('/reports/revenue', B.accountant)).body.data).toEqual([]);
      expect((await get('/reports/revenue?groupBy=bogus')).status).toBe(400);
    });
  });

  describe('employee-performance report', () => {
    it('counts files, tasks and output per employee', async () => {
      const res = await get('/reports/employee-performance', A.owner);
      expect(res.status).toBe(200);
      const e = res.body.data.find((r: any) => r.employee === 'Emp CLEARANCE_OFFICER');
      expect(e).toMatchObject({ filesAssignedOpen: 1, filesClosedInPeriod: 1, avgDaysToClose: 5, tasksCompleted: 2, tasksOnTime: 1, tasksOverdueNow: 1, documentsUploaded: 1 });
      expect(e.serviceRevenue).toBe('1300.0000'); // F1 1000 + F3 300
      expect(e.profit).toBe('1250.0000'); // minus the 50 office cost on F1
      expect(res.body.data.length).toBe(5); // everyone, including people with no files
      expect(res.body.meta.basis).toBe('BASE_CURRENCY');
    });

    it('is limited to people who manage users, and to one employee on request', async () => {
      expect((await get('/reports/employee-performance', A.accountant)).status).toBe(403);
      expect((await get('/reports/employee-performance', A.officer)).status).toBe(403);
      const one = await get(`/reports/employee-performance?assignedTo=${officerId}`, A.owner);
      expect(one.body.data).toHaveLength(1);
    });
  });

  describe('export', () => {
    it('produces a real Excel workbook whose numbers are numbers, with totals and a labelled basis', async () => {
      const res = await get('/reports/export?report=expenses&format=xlsx', A.accountant).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="expenses-\d{8}\.xlsx"$/);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as any);
      const ws = wb.worksheets[0];
      expect(ws.name).toBe('Expenses');
      expect(String(ws.getCell(1, 1).value)).toBe('Office ops-a — Expenses');
      expect(String(ws.getCell(2, 1).value)).toContain('Amounts in base currency — USD');
      const header = ws.getRow(4).values as any[];
      expect(header.slice(1, 4)).toEqual(['Date', 'File', 'Category']);
      const amountCol = (ws.getRow(4).values as any[]).indexOf('Amount') ;
      const first = ws.getRow(5);
      expect(typeof first.getCell(amountCol).value).toBe('number'); // a number, so it sums and sorts in Excel
      expect(first.getCell(amountCol).numFmt).toContain('#,##0');
      const baseCol = (ws.getRow(4).values as any[]).indexOf('Amount (USD)');
      const total = ws.getRow(7);
      expect(total.getCell(baseCol).value).toBe(250);
      expect(total.font?.bold).toBe(true);
      expect(ws.views[0].rightToLeft).toBeFalsy();
    });

    it('exports in Arabic right-to-left with Arabic headers', async () => {
      const res = await get('/reports/export?report=revenue&format=xlsx&locale=ar', A.accountant).buffer(true).parse(binary);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as any);
      const ws = wb.worksheets[0];
      expect(ws.name).toBe('الإيرادات');
      expect(ws.views[0].rightToLeft).toBe(true);
      expect(String(ws.getCell(4, 1).value)).toBe('الشهر');
      expect(String(ws.getCell(2, 1).value)).toContain('المبالغ بالعملة الأساسية');
      expect(String(ws.getCell(1, 1).value)).toContain('الإيرادات');
    });

    it('writes per-currency totals separately in the client-balances export', async () => {
      const res = await get('/reports/export?report=client-balances&format=xlsx', A.accountant).buffer(true).parse(binary);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.body as any);
      const texts: string[] = [];
      wb.worksheets[0].eachRow((r) => texts.push(String(r.getCell(1).value ?? '')));
      expect(texts).toContain('Totals by currency');
      expect(texts.some((t) => t.startsWith('outstanding (LBP)'))).toBe(true);
      expect(texts.some((t) => t.startsWith('outstanding (USD)'))).toBe(true);
    });

    it('exports CSV with a BOM, proper quoting, and formula injection neutralised', async () => {
      await ok(api.req('post', '/clients', A.owner).send({ name: '=HYPERLINK("http://evil","x")' }));
      const evil = (await ok(api.req('get', '/clients?search=HYPERLINK', A.owner)))[0];
      const f = await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'IMPORT', clientId: evil.id, customsReference: '+cmd|calc' }));
      void f;
      const res = await get('/reports/export?report=clearance-files&format=csv', A.accountant).buffer(true).parse(binary);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      const body = (res.body as Buffer).toString('utf8');
      expect(body.charCodeAt(0)).toBe(0xfeff); // BOM so Excel reads UTF-8
      expect(body.slice(1).split('\r\n')[0]).toBe('"File number","Type","Status","Priority","Client","Branch","Assigned to","Stage","Opened","Expected arrival","Closed","Days open","Customs reference"');
      expect(body).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`); // a leading quote stops Excel running it as a formula, and embedded quotes are doubled
      expect(body).toContain(`"'+cmd|calc"`);
      expect(body).not.toMatch(/,"=HYPERLINK/);
    });

    it('exports the profitability, summary, trial-balance, revenue and employee tables too', async () => {
      for (const [report, token, sheet] of [['profitability', A.accountant, 'File profitability'], ['financial-summary', A.accountant, 'Financial summary'], ['trial-balance', A.accountant, 'Trial balance'], ['employee-performance', A.owner, 'Employee performance'], ['clearance-files', A.accountant, 'Clearance files']] as const) {
        const res = await get(`/reports/export?report=${report}&format=xlsx`, token).buffer(true).parse(binary);
        expect(res.status, report).toBe(200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(res.body as any);
        expect(wb.worksheets[0].name).toBe(sheet);
        expect(wb.worksheets[0].rowCount).toBeGreaterThan(4);
      }
      // the trial balance export is balanced
      const tb = await get('/reports/export?report=trial-balance&format=csv', A.accountant).buffer(true).parse(binary);
      const lines = (tb.body as Buffer).toString('utf8').trim().split('\r\n');
      const totals = lines.at(-1)!.split(',');
      expect(totals[3]).toBe(totals[4]); // total debit equals total credit
    });

    it('applies the same permissions as the report pages, and audits every export', async () => {
      expect((await get('/reports/export?report=expenses', A.viewer)).status).toBe(403); // viewers can read reports, but not export
      expect((await get('/reports/export?report=expenses', A.officer)).status).toBe(403);
      expect((await get('/reports/export?report=trial-balance', A.manager)).status).toBe(200);
      expect((await get('/reports/export?report=employee-performance', A.accountant)).status).toBe(403); // needs users.manage
      expect((await get('/reports/export?report=nope', A.accountant)).status).toBe(400);
      expect((await get('/reports/export?report=expenses&format=docx', A.accountant)).status).toBe(400);
      expect((await api.req('get', '/reports/export?report=expenses')).status).toBe(401);
      const logs = await api.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'REPORT_EXPORTED' } });
      expect(logs.length).toBeGreaterThan(5);
      expect(logs.some((l) => (l.afterData as any).locale === 'ar')).toBe(true);
    });

    it('never exports another office\'s data', async () => {
      const res = await get('/reports/export?report=clearance-files&format=csv', B.accountant).buffer(true).parse(binary);
      const body = (res.body as Buffer).toString('utf8');
      expect(body).not.toContain('ops-a');
      expect(body.trim().split('\r\n')).toHaveLength(3); // header + B's single file + the totals row
    });
  });

  describe('dashboard', () => {
    it('summarises files for everyone, and shows tasks, documents and money only to those entitled to them', async () => {
      const owner = (await ok(get('/dashboard/overview', A.owner)));
      expect(owner.files).toMatchObject({ open: 4, closed: 1, highPriority: 1, unassigned: 3, onHold: 0, cancelled: 0 }); // F1, F2, F4 and the CSV test's file are open; F2, F4 and that file are unassigned
      expect(owner.tasks).toMatchObject({ myOpen: 0, myOverdue: 0, officeOverdue: 1 }); // the owner has none; the officer's overdue task counts for the office
      expect(owner.documents.pendingReview).toBeGreaterThanOrEqual(1);
      expect(owner.finance).toMatchObject({ baseCurrency: 'USD', unpaidInvoices: { count: 2, outstandingByCurrency: { USD: '1000.0000', LBP: '89500000.0000' } }, overdueInvoices: { count: 1, outstandingByCurrency: { USD: '1000.0000' } } });
      const officer = await ok(get('/dashboard/overview', A.officer));
      expect(officer.finance).toBeUndefined(); // officers do not see money on the dashboard
      expect(officer.tasks).toMatchObject({ myOpen: 1, myOverdue: 1, officeOverdue: 1 });
      const accountant = await ok(get('/dashboard/overview', A.accountant));
      expect(accountant.tasks).toBeUndefined(); // no tasks permission
      expect(accountant.finance).toBeDefined();
      expect((await ok(get('/dashboard/overview', B.owner))).files).toMatchObject({ open: 1, closed: 0 });
    });

    it('gives statistics: status, type, stage, workload and a zero-filled 12-month trend', async () => {
      const s = await ok(get('/dashboard/clearance-statistics', A.manager));
      expect(s.byStatus).toMatchObject({ OPEN: 4, CLOSED: 1 });
      expect(s.byType).toMatchObject({ IMPORT: 4, EXPORT: 1 });
      expect(s.openByStage[0]).toMatchObject({ stage: { code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد' }, count: 4 });
      expect(s.workload.map((w: any) => [w.employee, w.openFiles])).toEqual(expect.arrayContaining([['Unassigned', 3], ['Emp CLEARANCE_OFFICER', 1]]));
      expect(s.monthly).toHaveLength(12);
      expect(s.monthly.reduce((a: number, m: any) => a + m.opened, 0)).toBe(5);
      expect(s.monthly.reduce((a: number, m: any) => a + m.closed, 0)).toBe(1);
      expect(s.averageDaysToClose).toBe(5);
      expect(s.openByPriority).toMatchObject({ HIGH: 1, NORMAL: 3 });
    });

    it('lists files that need attention, each with the reason', async () => {
      const p = await ok(get('/dashboard/pending-files', A.officer));
      expect(p.thresholds).toEqual({ staleDays: 7, arrivingWithinDays: 7 });
      expect(p.overdueArrival.items.map((f: any) => f.id)).toEqual([F.f1]);
      expect(p.overdueArrival.items[0].daysLate).toBeGreaterThanOrEqual(2);
      expect(p.arrivingSoon.items.map((f: any) => f.id)).toEqual([F.f2]);
      expect(p.arrivingSoon.items[0].daysToArrival).toBe(3);
      expect(p.unassigned.total).toBe(3);
      expect(p.highPriority.items.map((f: any) => f.id)).toEqual([F.f1]);
      expect(p.stale.items.map((f: any) => f.id)).toEqual([F.f4]);
      expect(p.stale.items[0].daysQuiet).toBeGreaterThanOrEqual(19);
      const missing = Object.fromEntries(p.missingDocuments.items.map((f: any) => [f.id, f.missing.map((m: any) => m.nameEn).sort()]));
      expect(missing[F.f1]).toEqual(['Bill of Lading', 'Packing List']); // the invoice was uploaded
      expect(missing[F.f2]).toEqual(['Commercial Invoice', 'Packing List']); // an export needs two
    });

    it('honours the thresholds', async () => {
      expect((await ok(get('/dashboard/pending-files?staleDays=30', A.officer))).stale.total).toBe(0);
      expect((await ok(get('/dashboard/pending-files?arrivingWithinDays=1', A.officer))).arrivingSoon.items).toEqual([]);
      expect((await get('/dashboard/pending-files?staleDays=0', A.officer)).status).toBe(400);
      expect((await ok(get('/dashboard/pending-files?limit=1', A.officer))).missingDocuments.items).toHaveLength(1);
    });

    it('shows the newest activity first, with who did it and on which file', async () => {
      const a = await ok(get('/dashboard/recent-activities?limit=5', A.officer));
      expect(a).toHaveLength(5);
      const times = a.map((x: any) => new Date(x.createdAt).getTime());
      expect([...times].sort((x, y) => y - x)).toEqual(times);
      expect(a[0]).toMatchObject({ user: expect.any(String), file: { fileNumber: expect.stringMatching(/^IMP-|^EXP-/), client: expect.any(String) } });
      expect((await ok(get('/dashboard/recent-activities', B.owner))).every((x: any) => x.file.client.startsWith('Client of ops-b'))).toBe(true);
    });

    it('serves the financial block only with reports.view, and the rest with file access', async () => {
      expect((await get('/dashboard/financial-summary', A.accountant)).status).toBe(200);
      expect((await get('/dashboard/financial-summary', A.officer)).status).toBe(403);
      for (const p of ['/dashboard/overview', '/dashboard/clearance-statistics', '/dashboard/pending-files', '/dashboard/recent-activities']) {
        expect((await api.req('get', p)).status, p).toBe(401);
      }
    });
  });
});
