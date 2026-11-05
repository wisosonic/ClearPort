import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, trialBalance, type FinanceOffice } from './finance-helpers';

describe('expenses API', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;
  let vendorId: string;

  const exp = (token: string, body: Record<string, unknown>) =>
    api.req('post', '/expenses', token).send({ description: 'Expense', amount: '100', currencyCode: 'USD', expenseDate: '2026-11-03', ...body });
  /** a pass-through expense on file `fileId` */
  const portFee = (body: Record<string, unknown> = {}) =>
    exp(A.officer, { categoryId: A.cat[CAT.PORT], clearanceFileId: A.fileId, description: 'Port fee', ...body });
  const approve = (token: string, id: string, body: Record<string, unknown> = {}) => api.req('post', `/expenses/${id}/approve`, token).send(body);
  const entries = async (id: string) => (await ok(api.req('get', `/accounting/journal-entries?sourceType=EXPENSE&limit=100`, A.accountant))).filter((e: any) => e.sourceId === id);
  const cashBalance = async (id: string) => (await ok(api.req('get', '/cash-accounts', A.accountant))).find((c: any) => c.id === id).balance as string;

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'exp-a');
    B = await financeOffice(api, 'exp-b');
    vendorId = (await ok(api.req('post', '/parties', A.owner).send({ name: 'Beirut Port Authority', partyType: 'OTHER' }))).id;
  });
  afterAll(async () => api.close());

  describe('recording', () => {
    it('records a draft pass-through expense without touching the books', async () => {
      const e = await ok(portFee({ amount: '250.5', vendorId }));
      expect(e).toMatchObject({
        status: 'DRAFT', paymentStatus: 'UNPAID', amount: '250.5000', currencyCode: 'USD', exchangeRate: '1.0000000000',
        baseAmount: '250.5000', rateSource: 'BASE', paidBy: 'ON_BEHALF_OF_CLIENT', isBilled: false,
        category: { name: CAT.PORT, costTreatment: 'PASS_THROUGH' }, vendor: { name: 'Beirut Port Authority' }, clearanceFile: { id: A.fileId },
      });
      expect(await entries(e.id)).toEqual([]);
      const tl = await ok(api.req('get', `/clearance-files/${A.fileId}/timeline`, A.owner));
      expect(tl.some((t: any) => t.activityType === 'EXPENSE_RECORDED' && t.description.includes('Port fee'))).toBe(true);
    });

    it('converts foreign currencies with the rate in force and keeps it on the record', async () => {
      const lbp = await ok(portFee({ amount: '8950000', currencyCode: 'LBP' }));
      expect(lbp).toMatchObject({ exchangeRate: '89500.0000000000', rateConvention: 'FOREIGN_PER_BASE', baseAmount: '100.0000', rateSource: 'test' });
      const eur = await ok(portFee({ amount: '100', currencyCode: 'EUR' }));
      expect(eur).toMatchObject({ exchangeRate: '1.0850000000', rateConvention: 'BASE_PER_FOREIGN', baseAmount: '108.5000' });
    });

    it('freezes the rate on the expense even if a new rate is recorded later', async () => {
      const e = await ok(portFee({ amount: '8950000', currencyCode: 'LBP' }));
      await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'LBP', rate: '100000', effectiveAt: '2026-12-01T00:00:00Z' }));
      const again = await ok(api.req('get', `/expenses/${e.id}`, A.owner));
      expect(again).toMatchObject({ exchangeRate: '89500.0000000000', baseAmount: '100.0000' }); // history is not rewritten
      const later = await ok(portFee({ amount: '10000000', currencyCode: 'LBP', expenseDate: '2026-12-02' }));
      expect(later).toMatchObject({ exchangeRate: '100000.0000000000', baseAmount: '100.0000' });
    });

    it('lets a transaction carry its own rate, recording the source', async () => {
      const e = await ok(portFee({ amount: '8950000', currencyCode: 'LBP', exchangeRate: '90000', rateConvention: 'FOREIGN_PER_BASE', rateSource: 'bank slip 123' }));
      expect(e).toMatchObject({ exchangeRate: '90000.0000000000', baseAmount: '99.4444', rateSource: 'bank slip 123' });
      expect((await portFee({ amount: '10', exchangeRate: '2' })).body.error.code).toBe('BASE_CURRENCY_RATE_IS_ONE');
    });

    it('refuses to guess a missing exchange rate', async () => {
      const res = await portFee({ currencyCode: 'GBP' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
      expect((await portFee({ currencyCode: 'LBP', expenseDate: '2025-06-01' })).body.error.code).toBe('EXCHANGE_RATE_REQUIRED'); // before any rate
    });

    it('applies the category rules: pass-through needs a file, revenue categories are not costs', async () => {
      const noFile = await exp(A.officer, { categoryId: A.cat[CAT.PORT] });
      expect(noFile.status).toBe(422);
      expect(noFile.body.error.code).toBe('FILE_REQUIRED_FOR_PASS_THROUGH');
      const office = await ok(exp(A.officer, { categoryId: A.cat[CAT.OFFICE], description: 'Stationery' })); // general office cost, no file
      expect(office).toMatchObject({ paidBy: 'OFFICE', clearanceFile: null });
      expect((await exp(A.officer, { categoryId: A.cat[CAT.SERVICE], clearanceFileId: A.fileId })).body.error.code).toBe('CATEGORY_NOT_FOR_EXPENSES');
      expect((await exp(A.officer, { categoryId: '00000000-0000-4000-8000-000000000000', clearanceFileId: A.fileId })).body.error.code).toBe('CATEGORY_NOT_FOUND');
      expect((await portFee({ vendorId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('VENDOR_NOT_FOUND');
      expect((await portFee({ clearanceFileId: '00000000-0000-4000-8000-000000000000' })).status).toBe(404);
      expect((await portFee({ currencyCode: 'ZZZ' })).body.error.code).toBe('CURRENCY_NOT_FOUND');
    });

    it('validates amounts and dates', async () => {
      for (const bad of [{ amount: '0' }, { amount: '-5' }, { amount: '1.23456' }, { amount: 'abc' }, { description: '' }, { expenseDate: 'tomorrow' }]) {
        expect((await portFee(bad)).status, JSON.stringify(bad)).toBe(400);
      }
    });

    it('requires expenses.create, and a viewer can only read', async () => {
      expect((await exp(A.viewer, { categoryId: A.cat[CAT.OFFICE] })).status).toBe(403);
      expect((await api.req('get', '/expenses', A.viewer)).status).toBe(200);
    });

    it('does not accept a smuggled status, approval or base amount', async () => {
      const e = await ok(portFee({ status: 'APPROVED', approvedBy: A.ownerId, baseAmount: '1', paymentStatus: 'PAID', paidBy: 'OFFICE' }));
      expect(e).toMatchObject({ status: 'DRAFT', approvedBy: null, baseAmount: '100.0000', paymentStatus: 'UNPAID', paidBy: 'ON_BEHALF_OF_CLIENT' });
    });
  });

  describe('editing drafts', () => {
    it('keeps the recorded rate when only unrelated fields change, and follows the amount', async () => {
      const e = await ok(portFee({ amount: '8950000', currencyCode: 'LBP', expenseDate: '2026-11-03' }));
      const desc = await ok(api.req('patch', `/expenses/${e.id}`, A.officer).send({ description: 'Renamed' }));
      expect(desc).toMatchObject({ description: 'Renamed', exchangeRate: '89500.0000000000', baseAmount: '100.0000' });
      const amt = await ok(api.req('patch', `/expenses/${e.id}`, A.officer).send({ amount: '17900000' }));
      expect(amt).toMatchObject({ amount: '17900000.0000', exchangeRate: '89500.0000000000', baseAmount: '200.0000' }); // same rate, new base
      const cur = await ok(api.req('patch', `/expenses/${e.id}`, A.officer).send({ currencyCode: 'USD', amount: '50' }));
      expect(cur).toMatchObject({ currencyCode: 'USD', exchangeRate: '1.0000000000', baseAmount: '50.0000' });
    });

    it('re-checks the category rules and refuses edits once approved', async () => {
      const e = await ok(portFee());
      expect((await api.req('patch', `/expenses/${e.id}`, A.officer).send({ clearanceFileId: null })).body.error.code).toBe('FILE_REQUIRED_FOR_PASS_THROUGH');
      expect((await api.req('patch', `/expenses/${e.id}`, A.officer).send({ status: 'APPROVED' })).status).toBe(400);
      await ok(approve(A.accountant, e.id));
      const res = await api.req('patch', `/expenses/${e.id}`, A.officer).send({ description: 'too late' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('EXPENSE_NOT_EDITABLE');
    });
  });

  describe('approving posts to the ledger', () => {
    it('pass-through paid from a cashbox: Dr disbursements / Cr cash, linked to the file', async () => {
      const e = await ok(portFee({ amount: '300' }));
      const before = await cashBalance(A.cash.usd);
      const done = await ok(approve(A.accountant, e.id, { cashAccountId: A.cash.usd, paidAt: '2026-11-04' }));
      expect(done).toMatchObject({ status: 'APPROVED', paymentStatus: 'PAID', cashAccount: { name: 'USD cashbox' } });
      expect(done.approvedAt).not.toBeNull();
      const [entry] = await entries(e.id);
      expect(entry).toMatchObject({ status: 'POSTED', sourceType: 'EXPENSE' });
      expect(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit, l.clearanceFileId]).sort()).toEqual([
        ['1010', '0.0000', '300.0000', A.fileId], ['1300', '300.0000', '0.0000', A.fileId],
      ].sort());
      expect(Number(before) - Number(await cashBalance(A.cash.usd))).toBe(300);
    });

    it('office expense goes to operating expenses, not to the client', async () => {
      const e = await ok(exp(A.officer, { categoryId: A.cat[CAT.OFFICE], description: 'Printer paper', amount: '40' }));
      await ok(approve(A.accountant, e.id));
      const [entry] = await entries(e.id);
      expect(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([['2200', '0.0000', '40.0000'], ['5100', '40.0000', '0.0000']].sort());
    });

    it('unpaid approval creates a payable', async () => {
      const e = await ok(portFee({ amount: '75' }));
      const before = (await trialBalance(api, A.accountant)).balance('2200');
      const done = await ok(approve(A.accountant, e.id));
      expect(done).toMatchObject({ status: 'APPROVED', paymentStatus: 'UNPAID', cashAccount: null });
      expect(Number((await trialBalance(api, A.accountant)).balance('2200')) - Number(before)).toBe(75);
    });

    it('requires the cash account to hold the expense currency', async () => {
      const e = await ok(portFee({ amount: '100' }));
      const res = await approve(A.accountant, e.id, { cashAccountId: A.cash.lbp });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('CASH_ACCOUNT_CURRENCY_MISMATCH');
      expect((await ok(api.req('get', `/expenses/${e.id}`, A.owner))).status).toBe('DRAFT'); // nothing half-done
      expect(await entries(e.id)).toEqual([]);
      expect((await approve(A.accountant, e.id, { cashAccountId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND');
    });

    it('books a foreign expense at its own recorded rate so both sides match exactly', async () => {
      const e = await ok(portFee({ amount: '8950000', currencyCode: 'LBP' }));
      await ok(approve(A.accountant, e.id, { cashAccountId: A.cash.lbp }));
      const [entry] = await entries(e.id);
      expect(entry.totals).toEqual({ baseDebit: '100.0000', baseCredit: '100.0000' });
      expect(entry.lines.every((l: any) => l.currencyCode === 'LBP' && l.exchangeRate === '89500.0000000000')).toBe(true);
    });

    it('can only be approved once, by someone with expenses.approve, and not on a closed file', async () => {
      const e = await ok(portFee());
      expect((await approve(A.officer, e.id)).status).toBe(403);
      const results = await Promise.all([approve(A.accountant, e.id), approve(A.manager, e.id)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await entries(e.id)).length).toBe(1); // exactly one posting
      expect((await approve(A.accountant, e.id)).body.error.code).toBe('EXPENSE_NOT_DRAFT');

      const closedFile = await A.newFile();
      const d = await ok(portFee({ clearanceFileId: closedFile }));
      await api.prisma.clearanceFile.update({ where: { id: closedFile }, data: { status: 'CLOSED', closedAt: new Date() } });
      expect((await approve(A.accountant, d.id)).body.error.code).toBe('FILE_NOT_EDITABLE');
      expect((await portFee({ clearanceFileId: closedFile })).body.error.code).toBe('FILE_NOT_EDITABLE');
    });

    it('keeps the books balanced through all of this', async () => {
      const t = await trialBalance(api, A.accountant);
      expect(t.balanced).toBe(true);
      expect(t.tb.totals.debit).toBe(t.tb.totals.credit);
    });
  });

  describe('segregation of duties', () => {
    it('lets an office require that someone else approves what a person recorded', async () => {
      const own = await ok(exp(A.accountant, { categoryId: A.cat[CAT.OFFICE], description: 'Own cost', amount: '10' }));
      const byOfficer = await ok(portFee({ description: 'Officer cost' }));
      // default: an office keeps working as before
      expect((await approve(A.accountant, own.id)).status).toBe(200);

      expect((await api.req('patch', '/tenant', A.owner).send({ allowSelfApproval: false })).body.data.allowSelfApproval).toBe(false);
      const own2 = await ok(exp(A.accountant, { categoryId: A.cat[CAT.OFFICE], description: 'Own cost 2', amount: '10' }));
      const refused = await approve(A.accountant, own2.id);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('SELF_APPROVAL_NOT_ALLOWED');
      expect((await ok(api.req('get', `/expenses/${own2.id}`, A.accountant))).status).toBe('DRAFT');
      expect((await approve(A.accountant, byOfficer.id)).status).toBe(200); // someone else's expense
      expect((await approve(A.owner, own2.id)).status).toBe(200); // another approver

      await api.req('patch', '/tenant', A.owner).send({ allowSelfApproval: true });
      expect((await api.req('patch', '/tenant', A.accountant).send({ allowSelfApproval: false })).status).toBe(403); // needs settings.manage
    });
  });

  describe('paying a payable later', () => {
    it('settles at the same value with no FX difference when the rate has not moved', async () => {
      const e = await ok(portFee({ amount: '120' }));
      await ok(approve(A.accountant, e.id));
      const paid = await ok(api.req('post', `/expenses/${e.id}/pay`, A.accountant).send({ cashAccountId: A.cash.usd, paidAt: '2026-11-10' }));
      expect(paid).toMatchObject({ paymentStatus: 'PAID', cashAccount: { name: 'USD cashbox' } });
      const pay = (await entries(e.id)).find((x: any) => x.description.startsWith('Payment of expense'));
      expect(pay.lines.map((l: any) => l.accountCode).sort()).toEqual(['1010', '2200']); // no 4300 line
    });

    it('books a realized FX gain when a foreign payable is settled at a better rate', async () => {
      // recorded 2026-11-03 at 89,500 LBP/USD: 8,950,000 LBP = 100 USD. By 2026-12-05 the rate is 100,000: it costs only 89.50 USD.
      const e = await ok(portFee({ amount: '8950000', currencyCode: 'LBP', expenseDate: '2026-11-03' }));
      await ok(approve(A.accountant, e.id));
      await ok(api.req('post', `/expenses/${e.id}/pay`, A.accountant).send({ cashAccountId: A.cash.lbp, paidAt: '2026-12-05' }));
      const pay = (await entries(e.id)).find((x: any) => x.description.startsWith('Payment of expense'));
      expect(pay.totals).toEqual({ baseDebit: '100.0000', baseCredit: '100.0000' });
      const byAcc = Object.fromEntries(pay.lines.map((l: any) => [l.accountCode, l]));
      expect(byAcc['2200']).toMatchObject({ debit: '8950000.0000', baseDebit: '100.0000', exchangeRate: '89500.0000000000' }); // cleared at its carrying value
      expect(byAcc['1020']).toMatchObject({ credit: '8950000.0000', baseCredit: '89.5000', exchangeRate: '100000.0000000000' }); // cash leaves at today's value
      expect(byAcc['4300']).toMatchObject({ credit: '10.5000', baseCredit: '10.5000', currencyCode: 'USD' }); // the 10.50 gain
      expect((await trialBalance(api, A.accountant)).balance('4300')).toBe('10.5000');
    });

    it('books a realized FX loss when the rate moves the other way', async () => {
      await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'EUR', rate: '1.2000', effectiveAt: '2026-12-10T00:00:00Z' }));
      const eurBox = await ok(api.req('post', '/cash-accounts', A.accountant).send({ name: 'Bank EUR', accountType: 'BANK', currencyCode: 'EUR' }));
      const e = await ok(portFee({ amount: '100', currencyCode: 'EUR', expenseDate: '2026-11-03' })); // 108.50 USD
      await ok(approve(A.accountant, e.id));
      await ok(api.req('post', `/expenses/${e.id}/pay`, A.accountant).send({ cashAccountId: eurBox.id, paidAt: '2026-12-15' })); // now costs 120.00 USD
      const pay = (await entries(e.id)).find((x: any) => x.description.startsWith('Payment of expense'));
      const fx = pay.lines.find((l: any) => l.accountCode === '4300');
      expect(fx).toMatchObject({ debit: '11.5000', baseDebit: '11.5000' }); // a 11.50 loss
      expect(pay.totals.baseDebit).toBe(pay.totals.baseCredit);
    });

    it('guards the payment step', async () => {
      const draft = await ok(portFee());
      expect((await api.req('post', `/expenses/${draft.id}/pay`, A.accountant).send({ cashAccountId: A.cash.usd })).body.error.code).toBe('EXPENSE_NOT_APPROVED');
      await ok(approve(A.accountant, draft.id, { cashAccountId: A.cash.usd }));
      expect((await api.req('post', `/expenses/${draft.id}/pay`, A.accountant).send({ cashAccountId: A.cash.usd })).body.error.code).toBe('EXPENSE_ALREADY_PAID');
      const unpaid = await ok(portFee()); await ok(approve(A.accountant, unpaid.id));
      expect((await api.req('post', `/expenses/${unpaid.id}/pay`, A.accountant).send({ cashAccountId: A.cash.lbp })).body.error.code).toBe('CASH_ACCOUNT_CURRENCY_MISMATCH');
      expect((await api.req('post', `/expenses/${unpaid.id}/pay`, A.officer).send({ cashAccountId: A.cash.usd })).status).toBe(403);
    });
  });

  describe('cancelling', () => {
    it('cancels a draft without any ledger effect', async () => {
      const e = await ok(portFee());
      const res = await ok(api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'Entered twice' }));
      expect(res).toMatchObject({ status: 'CANCELLED', cancelReason: 'Entered twice' });
      expect(await entries(e.id)).toEqual([]);
      expect((await api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'again please' })).body.error.code).toBe('EXPENSE_ALREADY_CANCELLED');
    });

    it('reverses an approved and paid expense, returning the cash, and never deletes anything', async () => {
      const e = await ok(portFee({ amount: '60' }));
      await ok(approve(A.accountant, e.id, { cashAccountId: A.cash.usd }));
      const cashBefore = await cashBalance(A.cash.usd);
      const disbBefore = (await trialBalance(api, A.accountant)).balance('1300');
      await ok(api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'Wrong vendor' }));
      expect(Number(await cashBalance(A.cash.usd)) - Number(cashBefore)).toBe(60);
      expect(Number(disbBefore) - Number((await trialBalance(api, A.accountant)).balance('1300'))).toBe(60);
      const es = await entries(e.id);
      expect(es.map((x: any) => x.status)).toEqual(['REVERSED']); // the original is kept, marked reversed
      const reversals = await ok(api.req('get', '/accounting/journal-entries?sourceType=REVERSAL&limit=100', A.accountant));
      const mirror = reversals.find((r: any) => r.sourceId === es[0].id);
      expect(mirror).toMatchObject({ status: 'POSTED', reversalOfId: es[0].id }); // plus a mirror entry that offsets it
      expect(mirror.totals).toEqual(es[0].totals);
      expect(await api.prisma.expense.count({ where: { id: e.id } })).toBe(1);
      expect((await trialBalance(api, A.accountant)).balanced).toBe(true);
      expect((await api.req('patch', `/expenses/${e.id}`, A.officer).send({ description: 'x' })).body.error.code).toBe('EXPENSE_NOT_EDITABLE');
    });

    it('reverses both postings of an expense that was approved then paid', async () => {
      const e = await ok(portFee({ amount: '33' }));
      await ok(approve(A.accountant, e.id));
      await ok(api.req('post', `/expenses/${e.id}/pay`, A.accountant).send({ cashAccountId: A.cash.usd }));
      await ok(api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'Duplicate invoice from vendor' }));
      const es = await entries(e.id);
      expect(es.filter((x: any) => x.status === 'REVERSED')).toHaveLength(2);
      expect(es.filter((x: any) => x.sourceType === 'EXPENSE' && x.status === 'POSTED')).toHaveLength(0);
    });

    it('requires approval permission and a reason, and is audited', async () => {
      const e = await ok(portFee());
      expect((await api.req('post', `/expenses/${e.id}/cancel`, A.officer).send({ reason: 'not allowed' })).status).toBe(403);
      expect((await api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({})).status).toBe(400);
      expect((await api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'x' })).status).toBe(400);
      const logs = await api.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: { in: ['EXPENSE_RECORDED', 'EXPENSE_APPROVED', 'EXPENSE_PAID', 'EXPENSE_CANCELLED'] } } });
      expect(new Set(logs.map((l) => l.action)).size).toBe(4);
    });
  });

  describe('listing', () => {
    it('filters, searches, sorts and pages on the server', async () => {
      const all = await api.req('get', '/expenses?limit=100', A.viewer);
      expect(all.body.meta.total).toBeGreaterThan(15);
      expect((await ok(api.req('get', '/expenses?status=CANCELLED&limit=100', A.viewer))).every((e: any) => e.status === 'CANCELLED')).toBe(true);
      expect((await ok(api.req('get', '/expenses?paymentStatus=PAID&limit=100', A.viewer))).every((e: any) => e.paymentStatus === 'PAID')).toBe(true);
      expect((await ok(api.req('get', `/expenses?clearanceFileId=${A.fileId}&limit=100`, A.viewer))).every((e: any) => e.clearanceFile.id === A.fileId)).toBe(true);
      expect((await ok(api.req('get', `/expenses?categoryId=${A.cat[CAT.OFFICE]}&limit=100`, A.viewer))).every((e: any) => e.category.name === CAT.OFFICE)).toBe(true);
      expect((await ok(api.req('get', '/expenses?search=printer paper', A.viewer))).map((e: any) => e.description)).toEqual(['Printer paper']);
      expect((await ok(api.req('get', '/expenses?search=%25', A.viewer)))).toEqual([]);
      const day = await ok(api.req('get', '/expenses?from=2026-12-02&to=2026-12-02&limit=100', A.viewer));
      expect(day.length).toBe(1);
      const p1 = await api.req('get', '/expenses?limit=5&page=1&sort=amount:desc', A.viewer);
      expect(p1.body.data).toHaveLength(5);
      const amounts = p1.body.data.map((e: any) => Number(e.amount));
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
      expect((await ok(api.req('get', `/expenses?vendorId=${vendorId}&limit=100`, A.viewer))).every((e: any) => e.vendor.id === vendorId)).toBe(true);
      // money is stored as text, so sorting must be NUMERIC across the whole list ("900" < "89500000")
      const asc = (await ok(api.req('get', '/expenses?limit=100&sort=amount:asc', A.viewer))).map((e: any) => Number(e.amount));
      expect(asc.length).toBeGreaterThan(15);
      expect(asc).toEqual([...asc].sort((a, b) => a - b));
      expect(new Set(asc.map((n: number) => String(Math.trunc(n)).length)).size).toBeGreaterThan(2); // the data really mixes magnitudes
    });
  });

  describe('office isolation', () => {
    it('hides another office\'s expenses and refuses to use its data', async () => {
      const bExp = await ok(exp(B.officer, { categoryId: B.cat[CAT.PORT], clearanceFileId: B.fileId, description: 'B secret fee' }));
      for (const [m, p, body] of [
        ['get', `/expenses/${bExp.id}`, undefined], ['patch', `/expenses/${bExp.id}`, { description: 'hacked' }],
        ['post', `/expenses/${bExp.id}/approve`, {}], ['post', `/expenses/${bExp.id}/pay`, { cashAccountId: A.cash.usd }],
        ['post', `/expenses/${bExp.id}/cancel`, { reason: 'sabotage' }],
      ] as const) expect((await api.req(m, p, A.accountant).send(body)).status, `${m} ${p}`).toBe(404);
      expect((await ok(api.req('get', '/expenses?search=secret&limit=100', A.accountant)))).toEqual([]);
      // A's category, file, vendor and cash account cannot be used by B
      expect((await exp(B.officer, { categoryId: A.cat[CAT.PORT], clearanceFileId: B.fileId })).body.error.code).toBe('CATEGORY_NOT_FOUND');
      expect((await exp(B.officer, { categoryId: B.cat[CAT.PORT], clearanceFileId: A.fileId })).status).toBe(404);
      expect((await exp(B.officer, { categoryId: B.cat[CAT.PORT], clearanceFileId: B.fileId, vendorId })).body.error.code).toBe('VENDOR_NOT_FOUND');
      const bOk = await ok(exp(B.officer, { categoryId: B.cat[CAT.PORT], clearanceFileId: B.fileId }));
      expect((await approve(B.accountant, bOk.id, { cashAccountId: A.cash.usd })).body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND');
      expect((await ok(api.req('get', `/expenses/${bExp.id}`, B.owner))).status).toBe('DRAFT');
      expect((await trialBalance(api, B.accountant)).byCode['1300']).toBeUndefined(); // nothing of A's activity leaked into B's books
    });
  });
});
