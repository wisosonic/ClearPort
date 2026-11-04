import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, trialBalance, type FinanceOffice } from './finance-helpers';

describe('invoices API', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;

  const fee = (amount: string, extra: Record<string, unknown> = {}) => ({ description: 'Clearance fee', categoryId: A.cat[CAT.SERVICE], unitPrice: amount, ...extra });
  const draft = (body: Record<string, unknown>, token = A.accountant) => api.req('post', '/invoices', token).send({ clearanceFileId: A.fileId, ...body });
  const issue = (id: string, body: Record<string, unknown> = {}, token = A.accountant) => api.req('post', `/invoices/${id}/issue`, token).send({ issueDate: '2026-11-05', ...body });
  const cancel = (id: string, token = A.accountant) => api.req('post', `/invoices/${id}/cancel`, token).send({ reason: 'Issued in error' });
  /** an approved pass-through expense on file `fileId`, optionally paid from a cashbox */
  const approvedExpense = async (amount: string, extra: Record<string, unknown> = {}, fileId = A.fileId, token = A.officer) => {
    const e = await ok(api.req('post', '/expenses', token).send({ categoryId: A.cat[CAT.PORT], clearanceFileId: fileId, description: 'Port fee', amount, currencyCode: 'USD', expenseDate: '2026-11-03', ...extra }));
    await ok(api.req('post', `/expenses/${e.id}/approve`, A.accountant).send({ cashAccountId: (extra.currencyCode ?? 'USD') === 'LBP' ? A.cash.lbp : A.cash.usd }));
    return e as { id: string };
  };
  const bal = async (code: string) => (await trialBalance(api, A.accountant)).balance(code);
  const entriesFor = async (invoiceId: string) => (await ok(api.req('get', '/accounting/journal-entries?sourceType=INVOICE&limit=100', A.accountant))).filter((e: any) => e.sourceId === invoiceId);
  const settle = async (invoiceId: string, rawAmount: string, status: 'POSTED' | 'DRAFT' = 'POSTED') => {
    const amount = Number(rawAmount).toFixed(4); // the API always stores 4-decimal strings
    const payment = await api.prisma.payment.create({
    data: {
      tenantId: A.tenantId, clientId: A.clientId, paymentNumber: `T-${Math.random().toString(36).slice(2, 8)}`, paymentType: 'CLIENT_PAYMENT', amount, currencyCode: 'USD',
      exchangeRate: '1.0000000000', baseAmount: amount, paymentMethod: 'CASH', cashAccountId: A.cash.usd, paymentDate: new Date(), receivedBy: A.ownerId, status,
    } as any,
    });
    await api.prisma.paymentAllocation.create({ data: { tenantId: A.tenantId, paymentId: payment.id, invoiceId, allocatedAmount: amount, currencyCode: 'USD', paymentAmount: amount } });
    return payment;
  };

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'inv-a');
    B = await financeOffice(api, 'inv-b');
  });
  afterAll(async () => api.close());

  describe('drafts', () => {
    it('creates a numberless draft that touches nothing in the books', async () => {
      const d = await ok(draft({ items: [fee('200')] }));
      expect(d).toMatchObject({
        status: 'DRAFT', invoiceType: 'STANDARD', currencyCode: 'USD', subtotal: '200.0000', discount: '0.0000', taxAmount: '0.0000', totalAmount: '200.0000',
        client: { id: A.clientId }, clearanceFile: { id: A.fileId }, paidAmount: '0.0000', outstandingAmount: '200.0000', paymentStatus: null,
      });
      expect(d.invoiceNumber).toMatch(/^DRAFT-[0-9A-F]{8}$/);
      expect(d.items).toHaveLength(1);
      expect(d.items[0]).toMatchObject({ description: 'Clearance fee', quantity: '1.0000', unitPrice: '200.0000', amount: '200.0000', taxRate: '0.0000', category: { name: CAT.SERVICE } });
      expect(await entriesFor(d.id)).toEqual([]);
    });

    it('prices lines server-side as quantity x unit price, to 4 decimals', async () => {
      const d = await ok(draft({ items: [fee('12.3456', { quantity: '3' }), fee('0.0050', { quantity: '2.5' })] }));
      expect(d.items.map((i: any) => i.amount)).toEqual(['37.0368', '0.0125']);
      expect(d.subtotal).toBe('37.0493');
      const sneaky = await ok(draft({ items: [{ ...fee('100'), amount: '1', taxAmount: '999' }], totalAmount: '1', status: 'ISSUED', invoiceNumber: 'INV-1' }));
      expect(sneaky).toMatchObject({ totalAmount: '100.0000', status: 'DRAFT' });
      expect(sneaky.invoiceNumber).toMatch(/^DRAFT-/);
    });

    it('re-bills an approved pass-through expense at cost and marks it billed', async () => {
      const e = await approvedExpense('300');
      const d = await ok(draft({ items: [{ expenseId: e.id }] }));
      expect(d.items[0]).toMatchObject({ description: 'Port fee', quantity: '1.0000', unitPrice: '300.0000', amount: '300.0000', category: { name: CAT.PORT, costTreatment: 'PASS_THROUGH' }, expense: { id: e.id } });
      const billed = await ok(api.req('get', `/expenses/${e.id}`, A.owner));
      expect(billed).toMatchObject({ isBilled: true, billedOn: { id: d.id, status: 'DRAFT' } });
      const unbilled = await ok(api.req('get', '/expenses?billed=false&limit=100', A.owner));
      expect(unbilled.some((x: any) => x.id === e.id)).toBe(false);
      expect((await ok(api.req('get', '/expenses?billed=true&limit=100', A.owner))).some((x: any) => x.id === e.id)).toBe(true);
    });

    it('rejects every way of mis-billing an expense', async () => {
      const e = await approvedExpense('100');
      await ok(draft({ items: [{ expenseId: e.id }] }));
      expect((await draft({ items: [{ expenseId: e.id }] })).body.error.code).toBe('EXPENSE_ALREADY_BILLED'); // on another live invoice
      const fresh = await approvedExpense('15');
      const twice = await draft({ items: [{ expenseId: fresh.id }, { expenseId: fresh.id }] });
      expect(twice.body.error.code).toBe('EXPENSE_DUPLICATED');

      const notApproved = await ok(api.req('post', '/expenses', A.officer).send({ categoryId: A.cat[CAT.PORT], clearanceFileId: A.fileId, description: 'Draft only', amount: '5', currencyCode: 'USD', expenseDate: '2026-11-03' }));
      expect((await draft({ items: [{ expenseId: notApproved.id }] })).body.error.code).toBe('EXPENSE_NOT_APPROVED');
      const otherFile = await A.newFile();
      const elsewhere = await approvedExpense('10', {}, otherFile);
      expect((await draft({ items: [{ expenseId: elsewhere.id }] })).body.error.code).toBe('EXPENSE_FILE_MISMATCH');
      const lbp = await approvedExpense('8950000', { currencyCode: 'LBP' });
      expect((await draft({ items: [{ expenseId: lbp.id }] })).body.error.code).toBe('EXPENSE_CURRENCY_MISMATCH');
      const officeCost = await ok(api.req('post', '/expenses', A.officer).send({ categoryId: A.cat[CAT.OFFICE], description: 'Paper', amount: '9', currencyCode: 'USD' }));
      await ok(api.req('post', `/expenses/${officeCost.id}/approve`, A.accountant).send({}));
      expect((await draft({ items: [{ expenseId: officeCost.id }] })).body.error.code).toBe('EXPENSE_FILE_MISMATCH'); // not on this file, not pass-through
      expect((await draft({ items: [{ expenseId: '00000000-0000-4000-8000-000000000000' }] })).body.error.code).toBe('EXPENSE_NOT_FOUND');
      expect((await draft({ invoiceType: 'ADVANCE', items: [{ expenseId: e.id }] })).body.error.code).toBe('ADVANCE_CANNOT_REBILL');
    });

    it('enforces the category rules for non-expense lines', async () => {
      expect((await draft({ items: [fee('50', { categoryId: A.cat[CAT.PORT] })] })).body.error.code).toBe('PASS_THROUGH_NEEDS_EXPENSE');
      expect((await draft({ items: [fee('50', { categoryId: A.cat[CAT.OFFICE] })] })).body.error.code).toBe('CATEGORY_NOT_BILLABLE');
      expect((await draft({ items: [fee('50', { categoryId: '00000000-0000-4000-8000-000000000000' })] })).body.error.code).toBe('CATEGORY_NOT_FOUND');
      expect((await draft({ items: [{ categoryId: A.cat[CAT.SERVICE], unitPrice: '5' }] })).body.error.code).toBe('ITEM_DESCRIPTION_REQUIRED');
      expect((await draft({ items: [{ description: 'x', categoryId: A.cat[CAT.SERVICE] }] })).body.error.code).toBe('ITEM_PRICE_REQUIRED');
      expect((await draft({ items: [{ description: 'x', unitPrice: '5' }] })).body.error.code).toBe('ITEM_CATEGORY_REQUIRED');
    });

    it('validates the request shape, discount and file', async () => {
      for (const bad of [{ items: [] }, { items: [fee('-5')] }, { items: [fee('5', { quantity: '0' })] }, { items: [fee('1.23456')] }, { items: [fee('5')], discount: '-1' }, { items: [fee('5')], currencyCode: 'usd1' }]) {
        expect((await draft(bad)).status, JSON.stringify(bad)).toBe(400);
      }
      const tooMuch = await draft({ items: [fee('100')], discount: '150' });
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error.code).toBe('DISCOUNT_TOO_LARGE');
      expect(tooMuch.body.error.details[0]).toEqual({ maxDiscount: '100.0000' });
      expect((await api.req('post', '/invoices', A.accountant).send({ clearanceFileId: '00000000-0000-4000-8000-000000000000', items: [fee('5')] })).status).toBe(404);
      expect((await draft({ items: [fee('5')], currencyCode: 'ZZZ' })).body.error.code).toBe('CURRENCY_NOT_FOUND');
    });

    it('edits drafts (items, discount, currency) with totals following, but never issued ones', async () => {
      const d = await ok(draft({ items: [fee('100')] }));
      const e = await approvedExpense('40');
      const upd = await ok(api.req('patch', `/invoices/${d.id}`, A.accountant).send({ items: [fee('250'), { expenseId: e.id }], discount: '25' }));
      expect(upd).toMatchObject({ subtotal: '290.0000', discount: '25.0000', totalAmount: '265.0000' });
      expect(upd.items).toHaveLength(2);
      // saving again with the same expense is fine (it is excluded from its own conflict check)
      expect((await ok(api.req('patch', `/invoices/${d.id}`, A.accountant).send({ discount: '30' }))).totalAmount).toBe('260.0000');
      expect((await api.req('patch', `/invoices/${d.id}`, A.accountant).send({ currencyCode: 'LBP' })).body.error.code).toBe('EXPENSE_CURRENCY_MISMATCH');
      expect((await api.req('patch', `/invoices/${d.id}`, A.accountant).send({ status: 'ISSUED' })).status).toBe(400);
      await ok(issue(d.id));
      const frozen = await api.req('patch', `/invoices/${d.id}`, A.accountant).send({ discount: '0' });
      expect(frozen.status).toBe(409);
      expect(frozen.body.error.code).toBe('INVOICE_NOT_EDITABLE');
    });
  });

  describe('issuing posts to the ledger', () => {
    it('numbers the invoice, freezes it, and posts receivable / revenue / disbursement exactly', async () => {
      const duty = await approvedExpense('500', { categoryId: A.cat[CAT.DUTIES], description: 'Customs duty' });
      const d = await ok(draft({ items: [fee('1000'), { expenseId: duty.id }] }));
      const ar0 = await bal('1200'); const rev0 = await bal('4100'); const disb0 = await bal('1300');
      const inv = await ok(issue(d.id, { issueDate: '2026-11-05' }));
      expect(inv).toMatchObject({
        status: 'ISSUED', totalAmount: '1500.0000', exchangeRate: '1.0000000000', rateSource: 'BASE',
        baseTotalAmount: '1500.0000', paymentStatus: 'UNPAID', paidAmount: '0.0000', outstandingAmount: '1500.0000', isOverdue: false,
      });
      expect(inv.invoiceNumber).toMatch(/^INV-2026-[0-9]{5}$/);
      expect(inv.issuedAt).not.toBeNull();
      expect(new Date(inv.dueDate).toISOString().slice(0, 10)).toBe('2026-12-05'); // issue date + the client's 30-day terms

      const [entry] = await entriesFor(d.id);
      expect(entry).toMatchObject({ status: 'POSTED', description: `Invoice ${inv.invoiceNumber}`, totals: { baseDebit: '1500.0000', baseCredit: '1500.0000' } });
      expect(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([
        ['1200', '1500.0000', '0.0000'], ['1300', '0.0000', '500.0000'], ['4100', '0.0000', '1000.0000'],
      ].sort());
      expect(entry.lines.every((l: any) => l.clearanceFileId === A.fileId)).toBe(true);
      expect(Number(await bal('1200')) - Number(ar0)).toBe(1500);
      expect(Number(await bal('4100')) - Number(rev0)).toBe(1000);
      expect(Number(disb0) - Number(await bal('1300'))).toBe(500); // the disbursement is cleared, NOT counted as revenue
      expect((await trialBalance(api, A.accountant)).balanced).toBe(true);
    });

    it('gives issued invoices gapless numbers, while drafts and cancelled drafts consume none', async () => {
      const d1 = await ok(draft({ items: [fee('10')] }));
      const stray = await ok(draft({ items: [fee('10')] }));
      await ok(cancel(stray.id)); // a cancelled draft never had a number
      const n = (x: { invoiceNumber: string }) => Number(x.invoiceNumber.slice(-5));
      const i2 = await ok(issue(d1.id));
      const d3 = await ok(draft({ items: [fee('10')] }));
      const i3 = await ok(issue(d3.id));
      expect(i2.invoiceNumber).toMatch(/^INV-2026-[0-9]{5}$/);
      expect(n(i3) - n(i2)).toBe(1); // consecutive: the cancelled draft in between used no number
    });

    it('applies the office\'s tax rate to taxable lines only, and snapshots it on each line', async () => {
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '11' }));
      const duty = await approvedExpense('200', { categoryId: A.cat[CAT.DUTIES] });
      const d = await ok(draft({ items: [fee('1000'), { expenseId: duty.id }] }));
      expect(d).toMatchObject({ subtotal: '1200.0000', taxAmount: '110.0000', totalAmount: '1310.0000' }); // preview in the draft
      expect(d.items.map((i: any) => [i.taxRate, i.taxAmount])).toEqual([['11.0000', '110.0000'], ['0.0000', '0.0000']]);

      const tax0 = await bal('2300');
      const inv = await ok(issue(d.id));
      expect(inv.totalAmount).toBe('1310.0000');
      const [entry] = await entriesFor(d.id);
      expect(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([
        ['1200', '1310.0000', '0.0000'], ['1300', '0.0000', '200.0000'], ['2300', '0.0000', '110.0000'], ['4100', '0.0000', '1000.0000'],
      ].sort());
      expect(Number(await bal('2300')) - Number(tax0)).toBe(110);

      // changing the rate later never alters an issued invoice
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '15' }));
      const again = await ok(api.req('get', `/invoices/${d.id}`, A.owner));
      expect(again).toMatchObject({ taxAmount: '110.0000', totalAmount: '1310.0000' });
      expect(again.items[0].taxRate).toBe('11.0000');
    });

    it('recomputes a draft at the CURRENT tax rate when it is issued', async () => {
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '10' }));
      const d = await ok(draft({ items: [fee('1000')] }));
      expect(d.taxAmount).toBe('100.0000');
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '5' }));
      const inv = await ok(issue(d.id));
      expect(inv).toMatchObject({ taxAmount: '50.0000', totalAmount: '1050.0000' });
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: false, name: 'VAT', ratePercent: '5' })); // off again
      expect((await ok(draft({ items: [fee('1000')] }))).taxAmount).toBe('0.0000');
    });

    it('takes the discount from service fees before tax', async () => {
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: true, name: 'VAT', ratePercent: '11' }));
      const d = await ok(draft({ items: [fee('1000')], discount: '100' }));
      const inv = await ok(issue(d.id));
      expect(inv).toMatchObject({ subtotal: '1000.0000', discount: '100.0000', taxAmount: '99.0000', totalAmount: '999.0000' });
      const [entry] = await entriesFor(d.id);
      expect(entry.lines.map((l: any) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([
        ['1200', '999.0000', '0.0000'], ['2300', '0.0000', '99.0000'], ['4100', '0.0000', '900.0000'],
      ].sort());
      await ok(api.req('put', '/settings/tax', A.owner).send({ enabled: false, name: 'VAT', ratePercent: '0' }));
    });

    it('invoices in a foreign currency at the rate of the issue date, and records that rate on the invoice', async () => {
      // 89,500,000 LBP at 89,500 LBP per USD = 1,000 USD
      const d = await ok(draft({ currencyCode: 'LBP', items: [fee('89500000')] }));
      const inv = await ok(issue(d.id, { issueDate: '2026-11-05' }));
      expect(inv).toMatchObject({ currencyCode: 'LBP', totalAmount: '89500000.0000', exchangeRate: '89500.0000000000', rateConvention: 'FOREIGN_PER_BASE', rateSource: 'test', baseTotalAmount: '1000.0000' });
      const [entry] = await entriesFor(d.id);
      expect(entry.totals).toEqual({ baseDebit: '1000.0000', baseCredit: '1000.0000' });
      expect(entry.lines.find((l: any) => l.accountCode === '1200')).toMatchObject({ currencyCode: 'LBP', debit: '89500000.0000', baseDebit: '1000.0000' });
      // an agreed rate can be given at issue and is recorded as the source
      const d2 = await ok(draft({ currencyCode: 'LBP', items: [fee('90000000')] }));
      const inv2 = await ok(issue(d2.id, { exchangeRate: '90000', rateConvention: 'FOREIGN_PER_BASE', rateSource: 'agreed with client' }));
      expect(inv2).toMatchObject({ exchangeRate: '90000.0000000000', rateSource: 'agreed with client', baseTotalAmount: '1000.0000' });
    });

    it('clears a disbursement at the value it was booked with, even when the rate has moved', async () => {
      // port fee 8,950,000 LBP on 3 Nov at 89,500 => 100.00 USD booked to disbursements.
      await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'LBP', rate: '100000', effectiveAt: '2026-12-05T00:00:00Z', source: 'test' }));
      const disb0 = await bal('1300');
      const lbpExpense = await approvedExpense('8950000', { currencyCode: 'LBP' }); // +100 USD in 1300
      expect(Number(await bal('1300')) - Number(disb0)).toBe(100);
      const d = await ok(draft({ currencyCode: 'LBP', items: [fee('8950000'), { expenseId: lbpExpense.id }] }));
      const inv = await ok(issue(d.id, { issueDate: '2026-12-10' })); // by now the rate is 100,000: the fee is worth 89.50 USD
      expect(inv).toMatchObject({ totalAmount: '17900000.0000', exchangeRate: '100000.0000000000', baseTotalAmount: '189.5000' });
      const [entry] = await entriesFor(d.id);
      expect(entry.totals).toEqual({ baseDebit: '189.5000', baseCredit: '189.5000' });
      const byAcc = Object.fromEntries(entry.lines.map((l: any) => [l.accountCode, l]));
      expect(byAcc['4100']).toMatchObject({ credit: '8950000.0000', baseCredit: '89.5000' });
      expect(byAcc['1300']).toMatchObject({ credit: '8950000.0000', baseCredit: '100.0000', exchangeRate: '89500.0000000000' }); // its ORIGINAL value
      expect(Number(disb0)).toBe(Number(await bal('1300'))); // 1300 is back to where it started: fully cleared, no residue
    });

    it('re-validates at issue time, refusing a changed world', async () => {
      const e = await approvedExpense('70');
      const d = await ok(draft({ items: [{ expenseId: e.id }, fee('10')] }));
      const blocked = await api.req('post', `/expenses/${e.id}/cancel`, A.accountant).send({ reason: 'Vendor credit note' });
      expect(blocked.body.error.code).toBe('EXPENSE_ALREADY_BILLED'); // the API refuses to cancel an expense that is on a draft
      await api.prisma.expense.update({ where: { id: e.id }, data: { status: 'CANCELLED' } }); // ...so simulate it changing behind the draft's back
      const res = await issue(d.id);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('EXPENSE_NOT_APPROVED');
      expect((await ok(api.req('get', `/invoices/${d.id}`, A.owner))).status).toBe('DRAFT'); // nothing half-issued
      expect(await entriesFor(d.id)).toEqual([]);

      const full = await ok(draft({ items: [fee('100')], discount: '100' }));
      expect((await issue(full.id)).body.error.code).toBe('INVOICE_TOTAL_ZERO');
    });

    it('lets only one of two simultaneous issues win and consumes one number', async () => {
      const d = await ok(draft({ items: [fee('33')] }));
      const results = await Promise.all([issue(d.id), issue(d.id, {}, A.manager)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect((await entriesFor(d.id)).length).toBe(1);
      const next = await ok(issue((await ok(draft({ items: [fee('1')] }))).id));
      const issuedNumber = (await ok(api.req('get', `/invoices/${d.id}`, A.owner))).invoiceNumber;
      expect(Number(next.invoiceNumber.slice(-5)) - Number(issuedNumber.slice(-5))).toBe(1); // no gap
      expect((await issue(d.id)).body.error.code).toBe('INVOICE_NOT_DRAFT');
    });

    it('is permission-gated and blocked on a closed file', async () => {
      const d = await ok(draft({ items: [fee('5')] }));
      expect((await issue(d.id, {}, A.officer)).status).toBe(403);
      expect((await issue(d.id, {}, A.viewer)).status).toBe(403);
      expect((await draft({ items: [fee('5')] }, A.viewer)).status).toBe(403);
      expect((await draft({ items: [fee('5')] }, A.officer)).status).toBe(403); // officers record expenses; invoicing is the accountant's job
      const closed = await A.newFile();
      const cd = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: closed, items: [fee('5')] }));
      await api.prisma.clearanceFile.update({ where: { id: closed }, data: { status: 'CLOSED', closedAt: new Date() } });
      expect((await issue(cd.id)).body.error.code).toBe('FILE_NOT_EDITABLE');
      expect((await api.req('post', '/invoices', A.accountant).send({ clearanceFileId: closed, items: [fee('5')] })).body.error.code).toBe('FILE_NOT_EDITABLE');
    });
  });

  describe('advance invoices', () => {
    it('are numbered requests for funds that post nothing', async () => {
      const ar0 = await bal('1200'); const rev0 = await bal('4100');
      const d = await ok(draft({ invoiceType: 'ADVANCE', items: [{ description: 'Advance on account', unitPrice: '500' }] }));
      expect(d).toMatchObject({ invoiceType: 'ADVANCE', totalAmount: '500.0000', taxAmount: '0.0000' });
      const inv = await ok(issue(d.id));
      expect(inv).toMatchObject({ status: 'ISSUED', paymentStatus: 'UNPAID', baseTotalAmount: '500.0000' });
      expect(inv.invoiceNumber).toMatch(/^INV-2026-/);
      expect(await entriesFor(d.id)).toEqual([]);
      expect(await bal('1200')).toBe(ar0);
      expect(await bal('4100')).toBe(rev0);
      expect(inv.isOverdue).toBe(false);
      expect((await draft({ invoiceType: 'ADVANCE', items: [{ description: 'x', unitPrice: '5' }], discount: '1' })).body.error.code).toBe('ADVANCE_NO_DISCOUNT');
    });

    it('cancel without any ledger entry to reverse', async () => {
      const d = await ok(draft({ invoiceType: 'ADVANCE', items: [{ description: 'Advance', unitPrice: '50' }] }));
      await ok(issue(d.id));
      const c = await ok(cancel(d.id));
      expect(c.status).toBe('CANCELLED');
    });
  });

  describe('cancelling', () => {
    it('cancels a draft without any effect and frees its expenses', async () => {
      const e = await approvedExpense('90');
      const d = await ok(draft({ items: [{ expenseId: e.id }] }));
      const c = await ok(cancel(d.id));
      expect(c).toMatchObject({ status: 'CANCELLED', cancelReason: 'Issued in error', outstandingAmount: '0.0000' });
      expect((await ok(api.req('get', `/expenses/${e.id}`, A.owner))).isBilled).toBe(false);
      await ok(draft({ items: [{ expenseId: e.id }] })); // can be re-billed
    });

    it('reverses an issued invoice in the ledger, keeps both entries, and frees its expenses', async () => {
      const e = await approvedExpense('80');
      const d = await ok(draft({ items: [fee('300'), { expenseId: e.id }] }));
      await ok(issue(d.id));
      const [snap] = [{ ar: await bal('1200'), rev: await bal('4100'), disb: await bal('1300') }];
      await ok(cancel(d.id));
      expect(Number(snap.ar) - Number(await bal('1200'))).toBe(380);
      expect(Number(snap.rev) - Number(await bal('4100'))).toBe(300);
      expect(Number(await bal('1300')) - Number(snap.disb)).toBe(80); // the disbursement is owed again
      const es = await entriesFor(d.id);
      expect(es.map((x: any) => x.status)).toEqual(['REVERSED']);
      expect((await trialBalance(api, A.accountant)).balanced).toBe(true);
      expect((await ok(api.req('get', `/expenses/${e.id}`, A.owner))).isBilled).toBe(false);
      expect(await api.prisma.invoice.count({ where: { id: d.id } })).toBe(1); // never deleted
      expect((await cancel(d.id)).body.error.code).toBe('INVOICE_ALREADY_CANCELLED');
      expect((await api.req('patch', `/invoices/${d.id}`, A.accountant).send({ discount: '0' })).body.error.code).toBe('INVOICE_NOT_EDITABLE');
    });

    it('refuses while payments are applied, and when the user may not issue', async () => {
      const d = await ok(draft({ items: [fee('100')] }));
      await ok(issue(d.id));
      await settle(d.id, '40');
      const res = await cancel(d.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVOICE_HAS_ALLOCATIONS');
      expect(res.body.error.details[0]).toMatchObject({ allocatedAmount: '40.0000' });
      expect((await cancel((await ok(draft({ items: [fee('5')] }))).id, A.officer)).status).toBe(403);
      expect((await api.req('post', `/invoices/${d.id}/cancel`, A.accountant).send({})).status).toBe(400);
    });
  });

  describe('derived payment status', () => {
    it('derives paid, outstanding and status from allocations and never stores them', async () => {
      const d = await ok(draft({ items: [fee('1000')] }));
      await ok(issue(d.id));
      expect(await ok(api.req('get', `/invoices/${d.id}`, A.owner))).toMatchObject({ paidAmount: '0.0000', outstandingAmount: '1000.0000', paymentStatus: 'UNPAID' });
      await settle(d.id, '300');
      expect(await ok(api.req('get', `/invoices/${d.id}`, A.owner))).toMatchObject({ paidAmount: '300.0000', outstandingAmount: '700.0000', paymentStatus: 'PARTIALLY_PAID' });
      await settle(d.id, '100', 'DRAFT'); // an unposted payment does not count
      await api.prisma.paymentAllocation.updateMany({ where: { invoiceId: d.id, paymentAmount: '40.0000' }, data: { reversedAt: new Date() } });
      expect((await ok(api.req('get', `/invoices/${d.id}`, A.owner))).paidAmount).toBe('300.0000');
      await settle(d.id, '700');
      const paid = await ok(api.req('get', `/invoices/${d.id}`, A.owner));
      expect(paid).toMatchObject({ paidAmount: '1000.0000', outstandingAmount: '0.0000', paymentStatus: 'PAID', isOverdue: false });
      expect(paid.allocations).toHaveLength(3);
      const columns = await api.prisma.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info(invoices)');
      expect(columns.map((c) => c.name)).not.toContain('paidAmount'); // there is no such column
    });

    it('flags overdue invoices, and never an advance request or a paid invoice', async () => {
      const d = await ok(draft({ items: [fee('50')] }));
      await ok(issue(d.id, { issueDate: '2026-01-10', dueDate: '2026-02-10' }));
      expect((await ok(api.req('get', `/invoices/${d.id}`, A.owner))).isOverdue).toBe(true);
      const adv = await ok(draft({ invoiceType: 'ADVANCE', items: [{ description: 'Adv', unitPrice: '50' }] }));
      await ok(issue(adv.id, { issueDate: '2026-01-10', dueDate: '2026-02-10' }));
      expect((await ok(api.req('get', `/invoices/${adv.id}`, A.owner))).isOverdue).toBe(false);
      await settle(d.id, '50');
      expect((await ok(api.req('get', `/invoices/${d.id}`, A.owner))).isOverdue).toBe(false);
    });
  });

  describe('listing', () => {
    it('filters by status, type, client, file, dates, number and unpaid / overdue', async () => {
      const issued = await ok(api.req('get', '/invoices?status=ISSUED&limit=100', A.viewer));
      expect(issued.length).toBeGreaterThan(8);
      expect(issued.every((i: any) => i.status === 'ISSUED' && i.client.name && i.clearanceFile.fileNumber)).toBe(true);
      expect((await ok(api.req('get', '/invoices?invoiceType=ADVANCE&limit=100', A.viewer))).every((i: any) => i.invoiceType === 'ADVANCE')).toBe(true);
      expect((await ok(api.req('get', `/invoices?clientId=${A.clientId}&limit=100`, A.viewer))).length).toBeGreaterThan(8);
      expect((await ok(api.req('get', `/clearance-files/${A.fileId}/invoices?limit=100`, A.viewer))).every((i: any) => i.clearanceFile.id === A.fileId)).toBe(true);
      expect((await ok(api.req('get', '/invoices?search=INV-2026-00001', A.viewer))).map((i: any) => i.invoiceNumber)).toEqual(['INV-2026-00001']);
      expect((await ok(api.req('get', '/invoices?search=%25', A.viewer)))).toEqual([]);
      const day = await ok(api.req('get', '/invoices?from=2026-01-10&to=2026-01-10&limit=100', A.viewer));
      expect(day.length).toBe(2);

      const unpaid = await ok(api.req('get', '/invoices?unpaid=true&limit=100', A.viewer));
      expect(unpaid.every((i: any) => i.status === 'ISSUED' && Number(i.outstandingAmount) > 0 && i.invoiceType !== 'ADVANCE')).toBe(true);
      const overdue = await api.req('get', '/invoices?overdue=true&limit=100', A.viewer);
      expect(overdue.body.data.every((i: any) => i.isOverdue)).toBe(true);
      expect(overdue.body.meta.total).toBe(overdue.body.data.length);
      const p1 = await api.req('get', '/invoices?limit=4&page=1&sort=totalAmount:desc', A.viewer);
      expect(p1.body.data).toHaveLength(4);
      const totals = (await ok(api.req('get', '/invoices?limit=100&sort=totalAmount:asc', A.viewer))).map((i: any) => Number(i.totalAmount));
      expect(totals).toEqual([...totals].sort((a, b) => a - b)); // numeric, not lexicographic, across LBP and USD amounts
      expect(new Set(totals.map((n: number) => String(Math.trunc(n)).length)).size).toBeGreaterThan(2);
      const unpaidDesc = (await ok(api.req('get', '/invoices?unpaid=true&limit=100&sort=totalAmount:desc', A.viewer))).map((i: any) => Number(i.totalAmount));
      expect(unpaidDesc).toEqual([...unpaidDesc].sort((a, b) => b - a));
    });

    it('lets read-only roles view invoices', async () => {
      expect((await api.req('get', '/invoices', A.viewer)).status).toBe(200);
      const [one] = await ok(api.req('get', '/invoices?limit=1', A.viewer));
      expect((await api.req('get', `/invoices/${one.id}`, A.viewer)).status).toBe(200);
    });
  });

  describe('audit', () => {
    it('records every step with the rate and base value used', async () => {
      const logs = await api.prisma.auditLog.findMany({ where: { tenantId: A.tenantId, action: 'INVOICE_ISSUED' }, orderBy: { createdAt: 'asc' } });
      expect(logs.length).toBeGreaterThan(8);
      const first = logs.find((l) => (l.afterData as any).total === '1500.0000')!;
      expect(first.afterData).toMatchObject({ invoiceNumber: expect.stringMatching(/^INV-2026-[0-9]{5}$/), total: '1500.0000', currency: 'USD', rate: '1.0000000000', baseTotal: '1500.0000', posted: true });
      const actions = [...new Set((await api.prisma.auditLog.findMany({ where: { tenantId: A.tenantId } })).map((l) => l.action))];
      expect(actions).toEqual(expect.arrayContaining(['INVOICE_DRAFTED', 'INVOICE_DRAFT_UPDATED', 'INVOICE_ISSUED', 'INVOICE_CANCELLED']));
    });
  });

  describe('office isolation', () => {
    it('hides another office\'s invoices and refuses to use its expenses or categories', async () => {
      const bFee = { description: 'B fee', categoryId: B.cat[CAT.SERVICE], unitPrice: '77' };
      const bDraft = await ok(api.req('post', '/invoices', B.accountant).send({ clearanceFileId: B.fileId, items: [bFee] }));
      await ok(api.req('post', `/invoices/${bDraft.id}/issue`, B.accountant).send({ issueDate: '2026-11-05' }));
      for (const [m, p, body] of [
        ['get', `/invoices/${bDraft.id}`, undefined], ['patch', `/invoices/${bDraft.id}`, { discount: '1' }],
        ['post', `/invoices/${bDraft.id}/issue`, {}], ['post', `/invoices/${bDraft.id}/cancel`, { reason: 'sabotage' }],
      ] as const) expect((await api.req(m, p, A.accountant).send(body)).status, `${m} ${p}`).toBe(404);
      expect((await ok(api.req('get', '/invoices?search=INV-2026&limit=100', A.accountant))).every((i: any) => i.client.id === A.clientId)).toBe(true);
      expect((await api.req('post', '/invoices', A.accountant).send({ clearanceFileId: B.fileId, items: [fee('5')] })).status).toBe(404);
      expect((await api.req('post', '/invoices', A.accountant).send({ clearanceFileId: A.fileId, items: [{ ...fee('5'), categoryId: B.cat[CAT.SERVICE] }] })).body.error.code).toBe('CATEGORY_NOT_FOUND');
      const bExpense = await ok(api.req('post', '/expenses', B.officer).send({ categoryId: B.cat[CAT.PORT], clearanceFileId: B.fileId, description: 'B', amount: '5', currencyCode: 'USD' }));
      await api.req('post', `/expenses/${bExpense.id}/approve`, B.accountant).send({});
      expect((await draft({ items: [{ expenseId: bExpense.id }] })).body.error.code).toBe('EXPENSE_NOT_FOUND');
      // each office numbers its own invoices from 1
      expect((await ok(api.req('get', `/invoices/${bDraft.id}`, B.owner))).invoiceNumber).toBe('INV-2026-00001');
      expect(Number((await trialBalance(api, B.accountant)).balance('1200'))).toBe(77);
    });
  });
});
