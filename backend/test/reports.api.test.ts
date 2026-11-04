import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, trialBalance, type FinanceOffice } from './finance-helpers';

describe('financial reports API', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;
  let clientB2: string; // a second client of office A
  const F: Record<string, string> = {}; // named files

  const fee = (amount: string, extra: Record<string, unknown> = {}) => ({ description: 'Clearance fee', categoryId: A.cat[CAT.SERVICE], unitPrice: amount, ...extra });
  const expense = async (fileId: string | null, category: string, amount: string, o: { paid?: boolean; date?: string; currency?: string } = {}) => {
    const e = await ok(api.req('post', '/expenses', A.officer).send({
      categoryId: A.cat[category], ...(fileId && { clearanceFileId: fileId }), description: `${category} ${amount}`, amount, currencyCode: o.currency ?? 'USD', expenseDate: o.date ?? '2026-11-03',
    }));
    await ok(api.req('post', `/expenses/${e.id}/approve`, A.accountant).send(o.paid === false ? {} : { cashAccountId: A.cash.usd }));
    return e as { id: string };
  };
  const invoice = async (fileId: string, items: object[], o: { discount?: string; currency?: string; issueDate?: string; token?: string } = {}) => {
    const d = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: fileId, items, discount: o.discount ?? '0', currencyCode: o.currency ?? 'USD' }));
    return ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: o.issueDate ?? '2026-11-05' })) as Promise<any>;
  };
  const pay = (body: Record<string, unknown>) => api.req('post', '/payments', A.accountant).send({
    clientId: A.clientId, paymentType: 'CLIENT_PAYMENT', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH', paymentDate: '2026-11-06', amount: '1', ...body,
  });
  const costs = (fileId: string, token = A.accountant) => api.req('get', `/clearance-files/${fileId}/costs`, token);
  const profit = (qs = '', token = A.accountant) => api.req('get', `/reports/profitability?limit=100${qs}`, token);

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'rep-a');
    B = await financeOffice(api, 'rep-b');
    clientB2 = (await ok(api.req('post', '/clients', A.owner).send({ name: 'Other client' }))).id;
    await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'LBP', rate: '100000', effectiveAt: '2026-12-01T00:00:00Z' }));

    // ── F1: discounted invoice re-billing one of two pass-through expenses, plus an office cost ──
    F.f1 = A.fileId;
    const duty = await expense(F.f1, CAT.DUTIES, '500');
    await expense(F.f1, CAT.PORT, '200'); // never re-billed
    await expense(F.f1, CAT.OFFICE, '50', { paid: false });
    const i1 = await invoice(F.f1, [fee('1000'), { expenseId: duty.id }], { discount: '100' });
    const p1 = await ok(pay({ amount: '1400' }));
    await ok(api.req('post', `/payments/${p1.id}/allocate`, A.accountant).send({ allocations: [{ invoiceId: i1.id, amount: '1400' }] }));

    // ── F2: invoiced in LBP, settled with USD that is worth 100 USD less than the receivable ──
    F.f2 = await A.newFile();
    const i2 = await invoice(F.f2, [fee('89500000')], { currency: 'LBP' }); // carried at 1000 USD
    const p2 = await ok(pay({ amount: '900', paymentDate: '2026-12-05' }));
    await ok(api.req('post', `/payments/${p2.id}/allocate`, A.accountant).send({ allocations: [{ invoiceId: i2.id, amount: '900', invoiceAmount: '89500000' }] }));

    // ── F3: pass-through money only: nothing earned, 300 not yet recovered ──
    F.f3 = await A.newFile();
    await expense(F.f3, CAT.TRANSPORT, '300');

    // ── F4: an invoice that is issued and then cancelled ──
    F.f4 = await A.newFile();
    const i4 = await invoice(F.f4, [fee('400')]);
    await ok(api.req('post', `/invoices/${i4.id}/cancel`, A.accountant).send({ reason: 'Issued to the wrong client' }));

    // ── F5: a taxed invoice (11 %) ──
    await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '11' }));
    F.f5 = await A.newFile();
    await invoice(F.f5, [fee('1000')]);
    await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: false, name: 'VAT', ratePercent: '11' }));

    // ── F6: another client's export file ──
    F.f6 = (await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'EXPORT', clientId: clientB2 }))).id;
    const i6 = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: F.f6, items: [fee('200')] }));
    await ok(api.req('post', `/invoices/${i6.id}/issue`, A.accountant).send({ issueDate: '2026-11-08' }));
  });
  afterAll(async () => api.close());

  describe('one file\'s costs and profitability', () => {
    it('earns only service fees: pass-through, advances and tax are not income', async () => {
      const c = await ok(costs(F.f1));
      expect(c.basis).toBe('BASE_CURRENCY');
      expect(c.baseCurrency).toBe('USD');
      expect(c.profitability).toMatchObject({ serviceRevenue: '900.0000', officeCosts: '50.0000', profit: '850.0000', marginPercent: '94.44' });
      expect(c.taxCollected).toBe('0.0000');
      expect(c.fxGainLoss).toBe('0.0000');
    });

    it('tracks pass-through money separately: disbursed, re-billed, unrecovered', async () => {
      const c = await ok(costs(F.f1));
      expect(c.passThrough).toMatchObject({ disbursed: '700.0000', reBilled: '500.0000', unrecovered: '200.0000' });
      expect(c.passThrough.unbilledExpenses).toHaveLength(1);
      expect(c.passThrough.unbilledExpenses[0]).toMatchObject({ description: `${CAT.PORT} 200`, amount: '200.0000' });
      // the ledger's unrecovered balance equals disbursed - re-billed from the records
      expect(Number(c.passThrough.disbursed) - Number(c.passThrough.reBilled)).toBe(Number(c.passThrough.unrecovered));
      expect(c.expenses.passThrough).toMatchObject({ baseTotal: '700.0000', byCurrency: { USD: '700.0000' } });
      expect(c.expenses.office).toMatchObject({ baseTotal: '50.0000', byCurrency: { USD: '50.0000' } });
      expect(c.expenses.items.find((e: any) => e.category === CAT.DUTIES)).toMatchObject({ billed: true, reBilled: true, treatment: 'PASS_THROUGH' });
      expect(c.expenses.items.find((e: any) => e.category === CAT.PORT)).toMatchObject({ billed: false, reBilled: false });
    });

    it('lists invoices with paid and outstanding amounts per currency', async () => {
      const c = await ok(costs(F.f1));
      expect(c.invoices).toMatchObject({
        count: 1, invoicedByCurrency: { USD: '1400.0000' }, paidByCurrency: { USD: '1400.0000' }, outstandingByCurrency: { USD: '0.0000' },
      });
      expect(c.receivables.outstandingBase).toBe('0.0000'); // settled in full
    });

    it('keeps realized FX out of profit and shows it on its own line', async () => {
      const c = await ok(costs(F.f2));
      expect(c.profitability).toMatchObject({ serviceRevenue: '1000.0000', officeCosts: '0.0000', profit: '1000.0000', marginPercent: '100.00' });
      expect(c.fxGainLoss).toBe('-100.0000'); // a 100 USD loss, not deducted from profit
      expect(c.invoices.invoicedByCurrency).toEqual({ LBP: '89500000.0000' }); // original currency, not converted
      expect(c.invoices.items[0]).toMatchObject({ currencyCode: 'LBP', baseTotal: '1000.0000', outstanding: '0.0000' });
    });

    it('does not count pass-through only files as profit or loss', async () => {
      const c = await ok(costs(F.f3));
      expect(c.profitability).toMatchObject({ serviceRevenue: '0.0000', officeCosts: '0.0000', profit: '0.0000', marginPercent: null });
      expect(c.passThrough).toMatchObject({ disbursed: '300.0000', reBilled: '0.0000', unrecovered: '300.0000' });
    });

    it('removes a cancelled invoice\'s revenue completely', async () => {
      const c = await ok(costs(F.f4));
      expect(c.profitability.serviceRevenue).toBe('0.0000');
      expect(c.invoices.count).toBe(0);
      expect(c.receivables.outstandingBase).toBe('0.0000');
    });

    it('reports tax collected separately from revenue', async () => {
      const c = await ok(costs(F.f5));
      expect(c.profitability.serviceRevenue).toBe('1000.0000'); // tax is not revenue
      expect(c.taxCollected).toBe('110.0000');
      expect(c.receivables.outstandingBase).toBe('1110.0000'); // the client owes revenue + tax
    });

    it('follows the books when an expense is cancelled', async () => {
      const f = await A.newFile();
      const e = await expense(f, CAT.OFFICE, '75');
      expect((await ok(costs(f))).profitability.officeCosts).toBe('75.0000');
      await ok(api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'Entered twice' }));
      const after = await ok(costs(f));
      expect(after.profitability).toMatchObject({ officeCosts: '0.0000', profit: '0.0000' });
      expect(after.expenses.items).toEqual([]);
    });

    it('requires reports.view and hides other offices\' files', async () => {
      expect((await costs(F.f1, A.officer)).status).toBe(403); // officers see expenses, not profitability
      expect((await costs(F.f1, A.viewer)).status).toBe(200);
      expect((await costs(F.f1, B.accountant)).status).toBe(404);
      expect((await costs('00000000-0000-4000-8000-000000000000')).status).toBe(404);
      expect((await costs('not-a-uuid')).status).toBe(400);
    });
  });

  describe('profitability across files', () => {
    it('lists every file with its figures, most profitable first, and report-wide totals', async () => {
      const res = await profit();
      expect(res.status).toBe(200);
      const rows = res.body.data;
      const byNumber = Object.fromEntries(rows.map((r: any) => [r.id, r]));
      expect(byNumber[F.f1]).toMatchObject({ serviceRevenue: '900.0000', officeCosts: '50.0000', profit: '850.0000', marginPercent: '94.44', unrecoveredDisbursements: '200.0000', fxGainLoss: '0.0000' });
      expect(byNumber[F.f2]).toMatchObject({ profit: '1000.0000', fxGainLoss: '-100.0000' });
      expect(byNumber[F.f3]).toMatchObject({ profit: '0.0000', unrecoveredDisbursements: '300.0000' });
      expect(byNumber[F.f5]).toMatchObject({ serviceRevenue: '1000.0000', profit: '1000.0000' });
      const profits = rows.map((r: any) => Number(r.profit));
      expect(profits).toEqual([...profits].sort((a, b) => b - a)); // most profitable first
      expect(rows[0].client.name).toBeTruthy();
      const t = res.body.meta.totals;
      expect(t.serviceRevenue).toBe(rows.reduce((s: number, r: any) => s + Number(r.serviceRevenue), 0).toFixed(4));
      expect(t).toMatchObject({ serviceRevenue: '3100.0000', officeCosts: '50.0000', profit: '3050.0000', unrecoveredDisbursements: '500.0000', fxGainLoss: '-100.0000' });
      expect(res.body.meta).toMatchObject({ baseCurrency: 'USD', basis: 'BASE_CURRENCY', total: rows.length });
    });

    it('totals cover ALL matching files even when the list is paged', async () => {
      const page = await api.req('get', '/reports/profitability?limit=2&page=1', A.accountant);
      expect(page.body.data).toHaveLength(2);
      expect(page.body.meta.total).toBeGreaterThan(2);
      expect(page.body.meta.totals.serviceRevenue).toBe('3100.0000');
      const page2 = await api.req('get', '/reports/profitability?limit=2&page=2', A.accountant);
      expect(page2.body.data.map((r: any) => r.id)).not.toEqual(page.body.data.map((r: any) => r.id));
    });

    it('filters by client, file type, status, assignee', async () => {
      const other = await profit(`&clientId=${clientB2}`);
      expect(other.body.data.map((r: any) => r.id)).toEqual([F.f6]);
      expect(other.body.meta.totals).toMatchObject({ files: 1, serviceRevenue: '200.0000', profit: '200.0000' });
      expect((await profit('&fileType=EXPORT')).body.data.map((r: any) => r.id)).toEqual([F.f6]);
      expect((await profit('&status=CLOSED')).body.data).toEqual([]);
      expect((await profit(`&assignedTo=${A.ownerId}`)).body.data).toEqual([]);
      expect((await profit('&fileType=BOGUS')).status).toBe(400);
    });

    it('limits figures to a date range, using the dates of the postings', async () => {
      // 5 Nov: invoices issued; expenses were dated 3 Nov so their costs fall outside this window
      const day = await profit('&from=2026-11-05&to=2026-11-05');
      const f1 = day.body.data.find((r: any) => r.id === F.f1);
      expect(f1).toMatchObject({ serviceRevenue: '900.0000', officeCosts: '0.0000', profit: '900.0000' });
      expect(day.body.data.find((r: any) => r.id === F.f3)).toBeUndefined(); // nothing posted that day: not listed
      const nov3 = await profit('&from=2026-11-03&to=2026-11-03');
      expect(nov3.body.data.find((r: any) => r.id === F.f1)).toMatchObject({ serviceRevenue: '0.0000', officeCosts: '50.0000', profit: '-50.0000' });
      expect(nov3.body.data.find((r: any) => r.id === F.f3)).toMatchObject({ unrecoveredDisbursements: '300.0000' });
      // the two windows add up to the whole
      const whole = (await profit('&from=2026-11-03&to=2026-12-31')).body.meta.totals;
      expect(whole.serviceRevenue).toBe('3100.0000');
    });

    it('is open to report viewers and closed to everyone else', async () => {
      expect((await profit('', A.viewer)).status).toBe(200);
      expect((await profit('', A.manager)).status).toBe(200);
      expect((await profit('', A.officer)).status).toBe(403);
      expect((await api.req('get', '/reports/profitability')).status).toBe(401);
    });

    it('never mixes in another office', async () => {
      const b = await profit('', B.accountant);
      expect(b.body.data.every((r: any) => r.client.name.startsWith('Client of rep-b'))).toBe(true);
      expect(b.body.meta.totals).toMatchObject({ serviceRevenue: '0.0000', profit: '0.0000' });
    });
  });

  describe('financial summary reconciles with the ledger', () => {
    it('matches the trial balance for every account it reports', async () => {
      const s = (await ok(api.req('get', '/reports/financial-summary', A.accountant)));
      const tb = await trialBalance(api, A.accountant);
      expect(s.basis).toBe('BASE_CURRENCY');
      expect(s.position.receivables).toBe(tb.balance('1200'));
      expect(s.position.clientAdvancesHeld).toBe(tb.balance('2100'));
      expect(s.position.unrecoveredDisbursements).toBe(tb.balance('1300'));
      expect(s.position.payables).toBe(tb.balance('2200'));
      expect(s.position.taxesPayable).toBe(tb.balance('2300'));
      expect(s.results.serviceRevenue).toBe(tb.balance('4100'));
      expect(s.results.officeExpenses).toBe(tb.balance('5100'));
      expect(s.results.fxGainLoss).toBe(tb.balance('4300'));
      expect(s.results.operatingResult).toBe((Number(tb.balance('4100')) - Number(tb.balance('5100'))).toFixed(4));
      // the exact figures of this scenario
      expect(s.results).toMatchObject({ serviceRevenue: '3100.0000', officeExpenses: '50.0000', operatingResult: '3050.0000', fxGainLoss: '-100.0000' });
      // open invoices: F5 1,110 (1,000 + 110 tax) and F6 200; F1 and F2 are settled and F4 was cancelled
      expect(s.position).toMatchObject({ receivables: '1310.0000', unrecoveredDisbursements: '500.0000', payables: '50.0000', taxesPayable: '110.0000' });
    });

    it('reports cash in each account\'s own currency, and the base-currency carrying value', async () => {
      const s = await ok(api.req('get', '/reports/financial-summary', A.accountant));
      const cash = await ok(api.req('get', '/cash-accounts', A.accountant));
      expect(s.position.cashAccounts.map((c: any) => [c.name, c.balance])).toEqual(cash.map((c: any) => [c.name, c.balance]));
      const tb = await trialBalance(api, A.accountant);
      const cashBase = Number(tb.balance('1010')) + Number(tb.balance('1020'));
      expect(s.position.cashAndBankBase).toBe(cashBase.toFixed(4));
    });

    it('separates documents in their original currencies from the same documents in base currency', async () => {
      const s = await ok(api.req('get', '/reports/financial-summary', A.accountant));
      expect(s.transactionCurrency.invoiced).toMatchObject({ USD: expect.any(String), LBP: '89500000.0000' });
      expect(s.transactionCurrency.received).toMatchObject({ USD: '2300.0000' }); // 1,400 + 900
      expect(s.transactionCurrency.refunded).toEqual({});
      expect(s.documentsBase).toMatchObject({ received: '2300.0000', invoiceCount: 4, paymentCount: 2 }); // F1, F2, F5, F6 (F4 was cancelled)
      // USD invoices: F1 1,400 + F5 1,110 + F6 200 = 2,710 (F4 was cancelled); LBP invoice F2 carried at 1,000 => 3,710 base
      expect(s.transactionCurrency.invoiced.USD).toBe('2710.0000');
      expect(s.documentsBase.invoiced).toBe('3710.0000');
    });

    it('cuts the position off at the end date and measures movements inside the period', async () => {
      const asOf = '2026-11-05';
      const s = await ok(api.req('get', `/reports/financial-summary?to=${asOf}`, A.accountant));
      const tb = await trialBalance(api, A.accountant, asOf);
      expect(s.position.receivables).toBe(tb.balance('1200'));
      expect(s.position.clientAdvancesHeld).toBe(tb.balance('2100')); // the 6 Nov and 5 Dec payments are not in yet
      const period = await ok(api.req('get', '/reports/financial-summary?from=2026-11-05&to=2026-11-05', A.accountant));
      const before = await trialBalance(api, A.accountant, '2026-11-04');
      expect(Number(period.results.serviceRevenue)).toBe(Number(tb.balance('4100')) - Number(before.balance('4100')));
      expect(period.results.officeExpenses).toBe('0.0000'); // the 50 office cost was on 3 Nov
      expect(period.from).toBe('2026-11-05');
    });

    it('needs reports.view', async () => {
      expect((await api.req('get', '/reports/financial-summary', A.officer)).status).toBe(403);
      expect((await api.req('get', '/reports/financial-summary', A.viewer)).status).toBe(200);
      expect((await api.req('get', '/reports/financial-summary', B.accountant)).body.data.results.serviceRevenue).toBe('0.0000');
      expect((await api.req('get', '/reports/financial-summary?from=nope', A.accountant)).status).toBe(400);
    });
  });
});
