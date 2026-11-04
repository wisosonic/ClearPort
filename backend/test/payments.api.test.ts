import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, trialBalance, type FinanceOffice } from './finance-helpers';

describe('payments and allocations API', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;
  let client2: string;
  let file2: string;

  const fee = (amount: string) => ({ description: 'Clearance fee', categoryId: A.cat[CAT.SERVICE], unitPrice: amount });
  /** an issued service-fee invoice for client A (or `clientFile`) */
  const invoice = async (amount: string, o: { currency?: string; issueDate?: string; fileId?: string } = {}) => {
    const d = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: o.fileId ?? A.fileId, currencyCode: o.currency ?? 'USD', items: [fee(amount)] }));
    return ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: o.issueDate ?? '2026-11-05' })) as Promise<any>;
  };
  const pay = (body: Record<string, unknown>, token = A.accountant) =>
    api.req('post', '/payments', token).send({ clientId: A.clientId, paymentType: 'CLIENT_PAYMENT', amount: '100', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH', paymentDate: '2026-11-06', ...body });
  const allocate = (paymentId: string, allocations: object[], token = A.accountant) => api.req('post', `/payments/${paymentId}/allocate`, token).send({ allocations });
  const getInv = async (id: string) => ok(api.req('get', `/invoices/${id}`, A.owner));
  const getPay = async (id: string) => ok(api.req('get', `/payments/${id}`, A.owner));
  const bal = async (code: string) => (await trialBalance(api, A.accountant)).balance(code);
  const cash = async (id: string) => (await ok(api.req('get', '/cash-accounts', A.accountant))).find((c: any) => c.id === id).balance as string;
  const entriesOf = async (sourceType: string, sourceId: string) =>
    (await ok(api.req('get', `/accounting/journal-entries?sourceType=${sourceType}&limit=100`, A.accountant))).filter((e: any) => e.sourceId === sourceId);
  const lineMap = (entry: any) => Object.fromEntries(entry.lines.map((l: any) => [l.accountCode, l]));

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'pay-a');
    B = await financeOffice(api, 'pay-b');
    client2 = (await ok(api.req('post', '/clients', A.owner).send({ name: 'Second client' }))).id;
    file2 = (await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'IMPORT', clientId: client2 }))).id;
    // LBP at 100,000 per USD from 1 December (it was 89,500 before)
    await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'LBP', rate: '100000', effectiveAt: '2026-12-01T00:00:00Z', source: 'test' }));
  });
  afterAll(async () => api.close());

  describe('receiving money', () => {
    it('credits client advances (a liability) and the cashbox, never revenue', async () => {
      const rev0 = await bal('4100'); const adv0 = await bal('2100'); const cash0 = await cash(A.cash.usd);
      const p = await ok(pay({ paymentType: 'CLIENT_ADVANCE', amount: '1000', referenceNumber: 'BANK-REF-1' }));
      expect(p).toMatchObject({
        status: 'POSTED', paymentType: 'CLIENT_ADVANCE', amount: '1000.0000', currencyCode: 'USD', exchangeRate: '1.0000000000', baseAmount: '1000.0000',
        referenceNumber: 'BANK-REF-1', allocatedAmount: '0.0000', unallocatedAmount: '1000.0000', client: { id: A.clientId }, cashAccount: { name: 'USD cashbox' },
      });
      expect(p.paymentNumber).toMatch(/^PAY-2026-\d{5}$/);
      const [e] = await entriesOf('PAYMENT', p.id);
      expect(e.lines.map((l: any) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([['1010', '1000.0000', '0.0000'], ['2100', '0.0000', '1000.0000']].sort());
      expect(Number(await bal('2100')) - Number(adv0)).toBe(1000);
      expect(Number(await cash(A.cash.usd)) - Number(cash0)).toBe(1000);
      expect(await bal('4100')).toBe(rev0); // receiving an advance is NOT income
    });

    it('numbers payments consecutively and ties them to the client\'s balance', async () => {
      const a = await ok(pay({ amount: '10' })); const b = await ok(pay({ amount: '10' }));
      expect(Number(b.paymentNumber.slice(-5)) - Number(a.paymentNumber.slice(-5))).toBe(1);
      const bl = await ok(api.req('get', `/clients/${A.clientId}/balance`, A.accountant));
      const usd = bl.balances.find((x: any) => x.currency === 'USD');
      expect(Number(usd.unappliedCredit)).toBeGreaterThanOrEqual(1020);
      expect(Number(usd.netBalance)).toBe(-Number(usd.unappliedCredit)); // we hold credit for the client, so the net is negative
    });

    it('records a foreign receipt at the rate in force and keeps it', async () => {
      const lbp = await ok(pay({ amount: '89500000', currencyCode: 'LBP', cashAccountId: A.cash.lbp, paymentDate: '2026-11-06' }));
      expect(lbp).toMatchObject({ exchangeRate: '89500.0000000000', rateConvention: 'FOREIGN_PER_BASE', baseAmount: '1000.0000' });
      const [e] = await entriesOf('PAYMENT', lbp.id);
      expect(e.totals).toEqual({ baseDebit: '1000.0000', baseCredit: '1000.0000' });
      const later = await ok(pay({ amount: '100000000', currencyCode: 'LBP', cashAccountId: A.cash.lbp, paymentDate: '2026-12-02' }));
      expect(later).toMatchObject({ exchangeRate: '100000.0000000000', baseAmount: '1000.0000' });
    });

    it('validates everything it is given', async () => {
      const cases: [Record<string, unknown>, number, string?][] = [
        [{ clientId: '00000000-0000-4000-8000-000000000000' }, 422, 'CLIENT_NOT_FOUND'],
        [{ clearanceFileId: file2 }, 422, 'FILE_CLIENT_MISMATCH'],
        [{ paymentMethod: 'BARTER' }, 422, 'PAYMENT_METHOD_NOT_FOUND'],
        [{ cashAccountId: A.cash.lbp }, 422, 'CASH_ACCOUNT_CURRENCY_MISMATCH'],
        [{ cashAccountId: '00000000-0000-4000-8000-000000000000' }, 422, 'CASH_ACCOUNT_NOT_FOUND'],
        [{ currencyCode: 'GBP', cashAccountId: A.cash.usd }, 422, 'CASH_ACCOUNT_CURRENCY_MISMATCH'],
        [{ amount: '0' }, 400], [{ amount: '-5' }, 400], [{ paymentType: 'SUPPLIER_PAYMENT' }, 400], [{ paymentDate: 'tomorrow' }, 400],
      ];
      for (const [body, status, code] of cases) {
        const res = await pay(body);
        expect(res.status, JSON.stringify(body)).toBe(status);
        if (code) expect(res.body.error.code).toBe(code);
      }
      const gbp = await ok(api.req('post', '/cash-accounts', A.accountant).send({ name: 'GBP box', accountType: 'CASHBOX', currencyCode: 'GBP' }));
      expect((await pay({ currencyCode: 'GBP', cashAccountId: gbp.id })).body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    });

    it('requires payments.create; viewers and officers only read', async () => {
      expect((await pay({}, A.officer)).status).toBe(403);
      expect((await pay({}, A.viewer)).status).toBe(403);
      expect((await api.req('get', '/payments', A.viewer)).status).toBe(200);
      expect((await api.req('get', '/payments', A.officer)).status).toBe(200);
    });
  });

  describe('allocating to invoices (same currency)', () => {
    it('applies a payment in parts across several invoices, moving value from advances to receivables', async () => {
      const i1 = await invoice('300'); const i2 = await invoice('250');
      const p = await ok(pay({ amount: '600' }));
      const adv0 = await bal('2100'); const ar0 = await bal('1200');
      const res = await ok(allocate(p.id, [{ invoiceId: i1.id, amount: '300' }, { invoiceId: i2.id, amount: '250' }]));
      expect(res).toMatchObject({ allocatedAmount: '550.0000', unallocatedAmount: '50.0000' });
      expect(res.allocations).toHaveLength(2);
      expect(res.allocations[0]).toMatchObject({ allocatedAmount: '300.0000', paymentAmount: '300.0000', currencyCode: 'USD', reversedAt: null, invoice: { id: i1.id } });
      expect(await getInv(i1.id)).toMatchObject({ paymentStatus: 'PAID', outstandingAmount: '0.0000', paidAmount: '300.0000' });
      expect(await getInv(i2.id)).toMatchObject({ paymentStatus: 'PAID' });
      expect(Number(adv0) - Number(await bal('2100'))).toBe(550); // advances used up
      expect(Number(ar0) - Number(await bal('1200'))).toBe(550); // receivables cleared
      const allocEntries = (await ok(api.req('get', '/accounting/journal-entries?sourceType=ALLOCATION&limit=100', A.accountant))).filter((e: any) => e.description.includes(p.paymentNumber));
      expect(allocEntries).toHaveLength(2);
      expect(allocEntries.every((e: any) => e.lines.length === 2)).toBe(true); // no FX line for same-currency allocation
    });

    it('supports several partial payments on one invoice', async () => {
      const inv = await invoice('1000');
      const p1 = await ok(pay({ amount: '400' })); const p2 = await ok(pay({ amount: '350' })); const p3 = await ok(pay({ amount: '500' }));
      await ok(allocate(p1.id, [{ invoiceId: inv.id, amount: '400' }]));
      expect(await getInv(inv.id)).toMatchObject({ paymentStatus: 'PARTIALLY_PAID', paidAmount: '400.0000', outstandingAmount: '600.0000' });
      await ok(allocate(p2.id, [{ invoiceId: inv.id, amount: '350' }]));
      expect(await getInv(inv.id)).toMatchObject({ paidAmount: '750.0000', outstandingAmount: '250.0000' });
      await ok(allocate(p3.id, [{ invoiceId: inv.id, amount: '250' }]));
      const done = await getInv(inv.id);
      expect(done).toMatchObject({ paymentStatus: 'PAID', outstandingAmount: '0.0000' });
      expect(done.allocations).toHaveLength(3);
      expect(await getPay(p3.id)).toMatchObject({ unallocatedAmount: '250.0000' }); // the rest stays as credit
    });

    it('can allocate at the moment of receipt', async () => {
      const inv = await invoice('120');
      const p = await ok(pay({ amount: '120', allocations: [{ invoiceId: inv.id, amount: '120' }] }));
      expect(p).toMatchObject({ unallocatedAmount: '0.0000', allocatedAmount: '120.0000' });
      expect((await getInv(inv.id)).paymentStatus).toBe('PAID');
      // and the whole thing is atomic: a bad allocation leaves no payment behind
      const before = await api.prisma.payment.count();
      const bad = await pay({ amount: '50', allocations: [{ invoiceId: inv.id, amount: '50' }] }); // invoice already paid
      expect(bad.status).toBe(422);
      expect(await api.prisma.payment.count()).toBe(before);
    });

    it('refuses over-allocation of the invoice or of the payment', async () => {
      const inv = await invoice('100'); const p = await ok(pay({ amount: '500' }));
      const over = await allocate(p.id, [{ invoiceId: inv.id, amount: '100.0001' }]);
      expect(over.status).toBe(422);
      expect(over.body.error.code).toBe('OVER_ALLOCATION');
      expect(over.body.error.details[0]).toMatchObject({ outstanding: '100.0000' });
      const small = await ok(pay({ amount: '30' }));
      const exceeds = await allocate(small.id, [{ invoiceId: inv.id, amount: '30.0001' }]);
      expect(exceeds.body.error.code).toBe('PAYMENT_BALANCE_EXCEEDED');
      expect(exceeds.body.error.details[0]).toMatchObject({ unallocated: '30.0000' });
      // two allocations in one request that together exceed the payment: nothing is applied
      const i2 = await invoice('100'); const i3 = await invoice('100');
      const tooMuch = await allocate(small.id, [{ invoiceId: i2.id, amount: '20' }, { invoiceId: i3.id, amount: '20' }]);
      expect(tooMuch.body.error.code).toBe('PAYMENT_BALANCE_EXCEEDED');
      expect((await getPay(small.id)).allocatedAmount).toBe('0.0000');
      expect((await getInv(i2.id)).paidAmount).toBe('0.0000'); // the first allocation was rolled back
    });

    it('only allocates to issued, non-advance invoices of the same client', async () => {
      const p = await ok(pay({ amount: '500' }));
      const draft = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: A.fileId, items: [fee('50')] }));
      expect((await allocate(p.id, [{ invoiceId: draft.id, amount: '10' }])).body.error.code).toBe('INVOICE_NOT_ISSUED');
      const other = await invoice('50', { fileId: file2 }); // belongs to the second client
      expect((await allocate(p.id, [{ invoiceId: other.id, amount: '10' }])).body.error.code).toBe('CLIENT_MISMATCH');
      const adv = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: A.fileId, invoiceType: 'ADVANCE', items: [{ description: 'Advance', unitPrice: '100' }] }));
      await ok(api.req('post', `/invoices/${adv.id}/issue`, A.accountant).send({}));
      expect((await allocate(p.id, [{ invoiceId: adv.id, amount: '10' }])).body.error.code).toBe('ADVANCE_INVOICE_NOT_ALLOCATABLE');
      const cancelled = await invoice('20'); await ok(api.req('post', `/invoices/${cancelled.id}/cancel`, A.accountant).send({ reason: 'oops' }));
      expect((await allocate(p.id, [{ invoiceId: cancelled.id, amount: '10' }])).body.error.code).toBe('INVOICE_NOT_ISSUED');
      expect((await allocate(p.id, [{ invoiceId: '00000000-0000-4000-8000-000000000000', amount: '10' }])).body.error.code).toBe('INVOICE_NOT_FOUND');
      const same = await invoice('40');
      expect((await allocate(p.id, [{ invoiceId: same.id, amount: '10', invoiceAmount: '9' }])).body.error.code).toBe('INVOICE_AMOUNT_MISMATCH');
      expect((await allocate(p.id, [])).status).toBe(400);
      expect((await allocate(p.id, [{ invoiceId: same.id, amount: '0' }])).status).toBe(400);
    });

    it('lets two simultaneous allocations compete for the same money: only what fits succeeds', async () => {
      const i1 = await invoice('100'); const i2 = await invoice('100');
      const p = await ok(pay({ amount: '100' }));
      const results = await Promise.all([allocate(p.id, [{ invoiceId: i1.id, amount: '100' }]), allocate(p.id, [{ invoiceId: i2.id, amount: '100' }])]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
      expect(await getPay(p.id)).toMatchObject({ allocatedAmount: '100.0000', unallocatedAmount: '0.0000' });
    });

    it('requires payments.create', async () => {
      const inv = await invoice('10'); const p = await ok(pay({ amount: '10' }));
      expect((await allocate(p.id, [{ invoiceId: inv.id, amount: '10' }], A.officer)).status).toBe(403);
      expect((await allocate(p.id, [{ invoiceId: inv.id, amount: '10' }], A.viewer)).status).toBe(403);
    });
  });

  describe('cross-currency allocation and realized FX', () => {
    it('converts a USD payment into LBP at the payment date\'s rate; no FX when the rate is unchanged', async () => {
      const lbpInv = await invoice('89500000', { currency: 'LBP', issueDate: '2026-11-05' }); // carried at 1000 USD
      expect(lbpInv.baseTotalAmount).toBe('1000.0000');
      const p = await ok(pay({ amount: '500', paymentDate: '2026-11-06' })); // 500 USD at 89,500 = 44,750,000 LBP
      const res = await ok(allocate(p.id, [{ invoiceId: lbpInv.id, amount: '500' }]));
      expect(res.allocations[0]).toMatchObject({ paymentAmount: '500.0000', allocatedAmount: '44750000.0000', currencyCode: 'LBP', paymentBaseAmount: '500.0000', invoiceBaseAmount: '500.0000' });
      expect(await getInv(lbpInv.id)).toMatchObject({ paidAmount: '44750000.0000', outstandingAmount: '44750000.0000', paymentStatus: 'PARTIALLY_PAID' });
      const [e] = await entriesOf('ALLOCATION', res.allocations[0].id);
      expect(e.lines).toHaveLength(2); // value matched, so no FX line
      const m = lineMap(e);
      expect(m['2100']).toMatchObject({ currencyCode: 'USD', debit: '500.0000', baseDebit: '500.0000' });
      expect(m['1200']).toMatchObject({ currencyCode: 'LBP', credit: '44750000.0000', baseCredit: '500.0000' });
    });

    it('books a realized FX LOSS when the money received is worth less than the receivable it settles', async () => {
      const lbpInv = await invoice('89500000', { currency: 'LBP', issueDate: '2026-11-05' }); // carried at 1000 USD
      // the client settles the whole LBP invoice with only 900 USD (LBP has weakened to ~99,444/USD): we state what it covers
      const p = await ok(pay({ amount: '900', paymentDate: '2026-12-05' }));
      const res = await ok(allocate(p.id, [{ invoiceId: lbpInv.id, amount: '900', invoiceAmount: '89500000' }]));
      const alloc = res.allocations[0];
      expect(alloc).toMatchObject({ paymentAmount: '900.0000', allocatedAmount: '89500000.0000', paymentBaseAmount: '900.0000', invoiceBaseAmount: '1000.0000' });
      const [e] = await entriesOf('ALLOCATION', alloc.id);
      const m = lineMap(e);
      expect(m['4300']).toMatchObject({ debit: '100.0000', baseDebit: '100.0000', currencyCode: 'USD' }); // a 100 USD loss
      expect(e.totals).toEqual({ baseDebit: '1000.0000', baseCredit: '1000.0000' });
      expect(await getInv(lbpInv.id)).toMatchObject({ paymentStatus: 'PAID', outstandingAmount: '0.0000' });
    });

    it('books a realized FX GAIN when a foreign payment is worth more than the USD receivable it settles', async () => {
      const inv = await invoice('1000'); // USD receivable carried at 1000
      // 95,000,000 LBP at 89,500 = 1,061.4525 USD received, applied to a 1,000 USD invoice
      const p = await ok(pay({ amount: '95000000', currencyCode: 'LBP', cashAccountId: A.cash.lbp, paymentDate: '2026-11-06' }));
      expect(p.baseAmount).toBe('1061.4525');
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '95000000', invoiceAmount: '1000' }]));
      const [e] = await entriesOf('ALLOCATION', res.allocations[0].id);
      const m = lineMap(e);
      expect(m['2100']).toMatchObject({ currencyCode: 'LBP', debit: '95000000.0000', baseDebit: '1061.4525' });
      expect(m['1200']).toMatchObject({ currencyCode: 'USD', credit: '1000.0000', baseCredit: '1000.0000' });
      expect(m['4300']).toMatchObject({ credit: '61.4525', baseCredit: '61.4525' });
      expect(e.totals.baseDebit).toBe(e.totals.baseCredit);
      expect(await getInv(inv.id)).toMatchObject({ paymentStatus: 'PAID' });
    });

    it('converts an LBP receipt to a USD invoice at the payment-date rate by default', async () => {
      const inv = await invoice('1000');
      const p = await ok(pay({ amount: '89500000', currencyCode: 'LBP', cashAccountId: A.cash.lbp, paymentDate: '2026-11-06' }));
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '89500000' }]));
      expect(res.allocations[0]).toMatchObject({ paymentAmount: '89500000.0000', allocatedAmount: '1000.0000', currencyCode: 'USD' });
      expect((await getInv(inv.id)).paymentStatus).toBe('PAID');
    });

    it('converts between two non-base currencies through the base currency (EUR payment on a USD invoice)', async () => {
      await ok(api.req('post', '/cash-accounts', A.accountant).send({ name: 'EUR box 2', accountType: 'CASHBOX', currencyCode: 'EUR' }));
      const eur = (await ok(api.req('get', '/cash-accounts', A.accountant))).find((c: any) => c.name === 'EUR box 2');
      const inv = await invoice('100');
      const p = await ok(pay({ amount: '50', currencyCode: 'EUR', cashAccountId: eur.id, paymentDate: '2026-11-06' })); // EUR -> USD works (EUR has a rate)
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '50' }]));
      expect(res.allocations[0]).toMatchObject({ paymentAmount: '50.0000', allocatedAmount: '54.2500' }); // 50 EUR x 1.0850
    });
  });

  describe('exactness of rounding', () => {
    it('leaves nothing behind on advances or receivables when a payment or invoice is fully used', async () => {
      // an odd LBP payment split over three LBP invoices that are each paid exactly
      const i1 = await invoice('1000001', { currency: 'LBP' }); const i2 = await invoice('1234567', { currency: 'LBP' }); const i3 = await invoice('765433', { currency: 'LBP' });
      const total = '3000001';
      const p = await ok(pay({ amount: total, currencyCode: 'LBP', cashAccountId: A.cash.lbp }));
      const adv0 = await bal('2100'); const ar0 = await bal('1200');
      await ok(allocate(p.id, [{ invoiceId: i1.id, amount: '1000001' }, { invoiceId: i2.id, amount: '1234567' }, { invoiceId: i3.id, amount: '765433' }]));
      const allocs = await api.prisma.paymentAllocation.findMany({ where: { paymentId: p.id } });
      const sumStr = (xs: string[]) => xs.reduce((a, x) => a + Math.round(Number(x) * 10000), 0);
      expect(sumStr(allocs.map((a) => a.paymentBaseAmount))).toBe(Math.round(Number(p.baseAmount) * 10000)); // the payment's base value is used up exactly
      for (const inv of [i1, i2, i3]) {
        const mine = allocs.find((a) => a.invoiceId === inv.id)!;
        expect(mine.invoiceBaseAmount).toBe(inv.baseTotalAmount); // each invoice is cleared at exactly its carrying value
      }
      expect(Math.round((Number(adv0) - Number(await bal('2100'))) * 10000)).toBe(Math.round(Number(p.baseAmount) * 10000));
      expect(Math.round((Number(ar0) - Number(await bal('1200'))) * 10000)).toBe(sumStr([i1, i2, i3].map((i) => i.baseTotalAmount)));
      expect((await trialBalance(api, A.accountant)).balanced).toBe(true);
    });
  });

  describe('reversing and cancelling', () => {
    it('reverses an allocation: the invoice is open again, the credit is back, nothing is deleted', async () => {
      const inv = await invoice('200'); const p = await ok(pay({ amount: '200' }));
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '200' }]));
      const alloc = res.allocations[0];
      const adv = await bal('2100'); const ar = await bal('1200');
      const back = await ok(api.req('post', `/payments/${p.id}/allocations/${alloc.id}/reverse`, A.accountant).send({ reason: 'Applied to the wrong invoice' }));
      expect(back).toMatchObject({ unallocatedAmount: '200.0000', allocatedAmount: '0.0000' });
      expect(back.allocations[0]).toMatchObject({ id: alloc.id, reversedAt: expect.any(String), reversalReason: 'Applied to the wrong invoice' });
      expect(await getInv(inv.id)).toMatchObject({ paymentStatus: 'UNPAID', paidAmount: '0.0000', outstandingAmount: '200.0000' });
      expect(Number(await bal('2100')) - Number(adv)).toBe(200);
      expect(Number(await bal('1200')) - Number(ar)).toBe(200);
      const es = await entriesOf('ALLOCATION', alloc.id);
      expect(es.map((e: any) => e.status)).toEqual(['REVERSED']);
      expect(await api.prisma.paymentAllocation.count({ where: { id: alloc.id } })).toBe(1);
      expect((await api.req('post', `/payments/${p.id}/allocations/${alloc.id}/reverse`, A.accountant).send({ reason: 'again please' })).body.error.code).toBe('ALLOCATION_ALREADY_REVERSED');
      // the freed credit can be applied elsewhere, and a reversed allocation can be neither altered nor deleted in the database
      const inv2 = await invoice('200');
      await ok(allocate(p.id, [{ invoiceId: inv2.id, amount: '200' }]));
      await expect(api.prisma.paymentAllocation.delete({ where: { id: alloc.id } })).rejects.toThrow();
      await expect(api.prisma.paymentAllocation.update({ where: { id: alloc.id }, data: { allocatedAmount: '1.0000' } })).rejects.toThrow();
      await expect(api.prisma.paymentAllocation.update({ where: { id: alloc.id }, data: { reversedAt: null } })).rejects.toThrow();
    });

    it('reverses a cross-currency allocation including its FX line', async () => {
      const inv = await invoice('1000'); const p = await ok(pay({ amount: '95000000', currencyCode: 'LBP', cashAccountId: A.cash.lbp, paymentDate: '2026-11-06' }));
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '95000000', invoiceAmount: '1000' }]));
      const fx = await bal('4300');
      await ok(api.req('post', `/payments/${p.id}/allocations/${res.allocations[0].id}/reverse`, A.accountant).send({ reason: 'Wrong invoice' }));
      expect(Number(fx) - Number(await bal('4300'))).toBe(61.4525); // the gain is undone
      expect((await trialBalance(api, A.accountant)).balanced).toBe(true);
    });

    it('cancels an unallocated payment (cash returns, advances shrink), but not one still in use', async () => {
      const p = await ok(pay({ amount: '75' })); const inv = await invoice('75');
      await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '75' }]));
      const blocked = await api.req('post', `/payments/${p.id}/cancel`, A.accountant).send({ reason: 'Bounced cheque' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.error.code).toBe('PAYMENT_HAS_ALLOCATIONS');
      expect(blocked.body.error.details[0]).toMatchObject({ allocatedAmount: '75.0000' });
      await ok(api.req('post', `/payments/${p.id}/allocations/${(await getPay(p.id)).allocations[0].id}/reverse`, A.accountant).send({ reason: 'Bounced cheque' }));
      const cash0 = await cash(A.cash.usd); const adv0 = await bal('2100');
      const done = await ok(api.req('post', `/payments/${p.id}/cancel`, A.accountant).send({ reason: 'Bounced cheque' }));
      expect(done).toMatchObject({ status: 'CANCELLED', unallocatedAmount: '0.0000' });
      expect(Number(cash0) - Number(await cash(A.cash.usd))).toBe(75);
      expect(Number(adv0) - Number(await bal('2100'))).toBe(75);
      expect((await api.req('post', `/payments/${p.id}/cancel`, A.accountant).send({ reason: 'again please' })).body.error.code).toBe('PAYMENT_ALREADY_CANCELLED');
      expect((await allocate(p.id, [{ invoiceId: inv.id, amount: '10' }])).body.error.code).toBe('PAYMENT_NOT_POSTED');
      expect(await api.prisma.payment.count({ where: { id: p.id } })).toBe(1);
    });

    it('stops an invoice being cancelled while a payment is applied, until the allocation is reversed', async () => {
      const inv = await invoice('90'); const p = await ok(pay({ amount: '90' }));
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '90' }]));
      expect((await api.req('post', `/invoices/${inv.id}/cancel`, A.accountant).send({ reason: 'mistake' })).body.error.code).toBe('INVOICE_HAS_ALLOCATIONS');
      await ok(api.req('post', `/payments/${p.id}/allocations/${res.allocations[0].id}/reverse`, A.accountant).send({ reason: 'mistake' }));
      expect((await api.req('post', `/invoices/${inv.id}/cancel`, A.accountant).send({ reason: 'mistake' })).status).toBe(200);
    });

    it('treats files as read-only once closed', async () => {
      const closed = await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'IMPORT', clientId: A.clientId }));
      const inv = await invoice('60', { fileId: closed.id }); const p = await ok(pay({ amount: '60', clearanceFileId: closed.id }));
      const res = await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '60' }]));
      await api.prisma.clearanceFile.update({ where: { id: closed.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      const inv2 = await invoice('10', { fileId: A.fileId });
      expect((await allocate(p.id, [{ invoiceId: inv.id, amount: '1' }])).body.error.code).toBe('FILE_NOT_EDITABLE');
      expect((await api.req('post', `/payments/${p.id}/allocations/${res.allocations[0].id}/reverse`, A.accountant).send({ reason: 'after close' })).body.error.code).toBe('FILE_NOT_EDITABLE');
      expect(inv2.id).toBeTruthy();
    });

    it('requires a reason and payments.create to cancel or reverse', async () => {
      const p = await ok(pay({ amount: '5' }));
      expect((await api.req('post', `/payments/${p.id}/cancel`, A.accountant).send({})).status).toBe(400);
      expect((await api.req('post', `/payments/${p.id}/cancel`, A.officer).send({ reason: 'not allowed' })).status).toBe(403);
    });
  });

  describe('refunds', () => {
    it('pays back only unapplied credit', async () => {
      const c = await ok(api.req('post', '/clients', A.owner).send({ name: 'Refund client' }));
      const f = await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'IMPORT', clientId: c.id }));
      const inv = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: f.id, items: [fee('300')] }));
      await ok(api.req('post', `/invoices/${inv.id}/issue`, A.accountant).send({ issueDate: '2026-11-05' }));
      const p = await ok(pay({ clientId: c.id, amount: '1000', paymentType: 'CLIENT_ADVANCE' }));
      await ok(allocate(p.id, [{ invoiceId: inv.id, amount: '300' }])); // 700 of credit remains
      const cash0 = await cash(A.cash.usd); const adv0 = await bal('2100');
      const refund = await ok(pay({ clientId: c.id, paymentType: 'REFUND', amount: '200' }));
      expect(refund).toMatchObject({ paymentType: 'REFUND', status: 'POSTED', amount: '200.0000' });
      expect(Number(cash0) - Number(await cash(A.cash.usd))).toBe(200); // cash goes out
      expect(Number(adv0) - Number(await bal('2100'))).toBe(200); // the liability shrinks
      const [e] = await entriesOf('PAYMENT', refund.id);
      expect(e.lines.map((l: any) => [l.accountCode, l.debit, l.credit]).sort()).toEqual([['1010', '0.0000', '200.0000'], ['2100', '200.0000', '0.0000']].sort());
      const tooMuch = await pay({ clientId: c.id, paymentType: 'REFUND', amount: '500.0001' }); // only 500 is left
      expect(tooMuch.status).toBe(422);
      expect(tooMuch.body.error.code).toBe('INSUFFICIENT_CREDIT');
      expect(tooMuch.body.error.details[0]).toEqual({ available: '500.0000', currency: 'USD' });
      expect((await pay({ clientId: c.id, paymentType: 'REFUND', amount: '500' })).status).toBe(201);
      expect((await pay({ clientId: c.id, paymentType: 'REFUND', amount: '1' })).body.error.code).toBe('INSUFFICIENT_CREDIT');
      // a refund cannot be allocated, and the client's balance now shows nothing owed either way
      expect((await pay({ clientId: c.id, paymentType: 'REFUND', amount: '1', allocations: [{ invoiceId: inv.id, amount: '1' }] })).body.error.code).toBe('REFUND_CANNOT_ALLOCATE');
      const bl = (await ok(api.req('get', `/clients/${c.id}/balance`, A.accountant))).balances.find((x: any) => x.currency === 'USD');
      expect(bl).toMatchObject({ invoiced: '300.0000', received: '1000.0000', refunded: '700.0000', allocated: '300.0000', outstanding: '0.0000', unappliedCredit: '0.0000', netBalance: '0.0000' });
      expect((await api.req('post', `/payments/${refund.id}/allocate`, A.accountant).send({ allocations: [{ invoiceId: inv.id, amount: '1' }] })).body.error.code).toBe('NOT_A_RECEIPT');
    });

    it('measures credit in each payment\'s own currency', async () => {
      const c = await ok(api.req('post', '/clients', A.owner).send({ name: 'Two-currency client' }));
      await ok(pay({ clientId: c.id, amount: '100', currencyCode: 'LBP', cashAccountId: A.cash.lbp, paymentDate: '2026-11-06' }));
      expect((await pay({ clientId: c.id, paymentType: 'REFUND', amount: '50', currencyCode: 'USD', cashAccountId: A.cash.usd })).body.error.code).toBe('INSUFFICIENT_CREDIT'); // no USD credit
      expect((await pay({ clientId: c.id, paymentType: 'REFUND', amount: '100', currencyCode: 'LBP', cashAccountId: A.cash.lbp })).status).toBe(201);
    });
  });

  describe('statement and balance reconcile with the ledger', () => {
    it('reconciles a client\'s cross-currency activity: statement closing = balance net, per currency', async () => {
      const c = await ok(api.req('post', '/clients', A.owner).send({ name: 'Reconcile client' }));
      const f = await ok(api.req('post', '/clearance-files', A.owner).send({ fileType: 'IMPORT', clientId: c.id }));
      const mk = async (currency: string, amount: string) => {
        const d = await ok(api.req('post', '/invoices', A.accountant).send({ clearanceFileId: f.id, currencyCode: currency, items: [fee(amount)] }));
        return ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: '2026-11-05' })) as Promise<any>;
      };
      const lbpInv = await mk('LBP', '89500000'); const usdInv = await mk('USD', '400');
      const p = await ok(pay({ clientId: c.id, amount: '1000', paymentType: 'CLIENT_ADVANCE', paymentDate: '2026-11-06' }));
      await ok(allocate(p.id, [{ invoiceId: usdInv.id, amount: '400' }, { invoiceId: lbpInv.id, amount: '200' }])); // 200 USD -> 17,900,000 LBP
      const balance = (await ok(api.req('get', `/clients/${c.id}/balance`, A.accountant))).balances;
      const usd = balance.find((b: any) => b.currency === 'USD'); const lbp = balance.find((b: any) => b.currency === 'LBP');
      expect(usd).toMatchObject({ invoiced: '400.0000', allocated: '400.0000', outstanding: '0.0000', received: '1000.0000', unappliedCredit: '400.0000', netBalance: '-400.0000' });
      expect(lbp).toMatchObject({ invoiced: '89500000.0000', allocated: '17900000.0000', outstanding: '71600000.0000', unappliedCredit: '0.0000', netBalance: '71600000.0000' });
      const stmt = (await ok(api.req('get', `/clients/${c.id}/statement`, A.accountant)));
      expect(stmt.closingBalances).toEqual({ LBP: '71600000.0000', USD: '-400.0000' });
      for (const b of balance) expect(stmt.closingBalances[b.currency]).toBe(b.netBalance);
      expect(stmt.lines.filter((l: any) => l.type === 'ALLOCATION')).toHaveLength(2); // only the cross-currency one appears
    });

    it('keeps the ledger consistent with the sub-ledgers after all of the above', async () => {
      const t = await trialBalance(api, A.accountant);
      expect(t.balanced).toBe(true);
      // receivables (1200, base) = the base value still outstanding on issued, non-advance invoices
      const invoices = await api.prisma.invoice.findMany({ where: { tenantId: A.tenantId, status: 'ISSUED', invoiceType: { not: 'ADVANCE' } } });
      const allocs = await api.prisma.paymentAllocation.findMany({ where: { tenantId: A.tenantId, reversedAt: null, invoice: { status: 'ISSUED' } } });
      const open = invoices.reduce((s, i) => s + Math.round(Number(i.baseTotalAmount) * 10000), 0)
        - allocs.reduce((s, a) => s + Math.round(Number(a.invoiceBaseAmount) * 10000), 0);
      expect(Math.round(Number(t.balance('1200')) * 10000)).toBe(open);
      // client advances (2100, base) = received base value not yet applied, minus refunds
      const payments = await api.prisma.payment.findMany({ where: { tenantId: A.tenantId, status: 'POSTED' } });
      const receivedBase = payments.filter((p) => p.paymentType !== 'REFUND').reduce((s, p) => s + Math.round(Number(p.baseAmount) * 10000), 0);
      const refundBase = payments.filter((p) => p.paymentType === 'REFUND').reduce((s, p) => s + Math.round(Number(p.baseAmount) * 10000), 0);
      const appliedBase = allocs.reduce((s, a) => s + Math.round(Number(a.paymentBaseAmount) * 10000), 0);
      expect(Math.round(Number(t.balance('2100')) * 10000)).toBe(receivedBase - refundBase - appliedBase);
    });
  });

  describe('listing', () => {
    it('filters, searches and pages payments, with derived allocation figures', async () => {
      const all = await api.req('get', '/payments?limit=100', A.viewer);
      expect(all.body.meta.total).toBeGreaterThan(15);
      expect(all.body.data.every((p: any) => p.client.name && typeof p.unallocatedAmount === 'string')).toBe(true);
      expect((await ok(api.req('get', '/payments?paymentType=REFUND&limit=100', A.viewer))).every((p: any) => p.paymentType === 'REFUND')).toBe(true);
      expect((await ok(api.req('get', '/payments?status=CANCELLED&limit=100', A.viewer))).every((p: any) => p.status === 'CANCELLED')).toBe(true);
      expect((await ok(api.req('get', `/payments?cashAccountId=${A.cash.lbp}&limit=100`, A.viewer))).every((p: any) => p.currencyCode === 'LBP')).toBe(true);
      expect((await ok(api.req('get', `/payments?clientId=${client2}`, A.viewer)))).toEqual([]);
      expect((await ok(api.req('get', '/payments?search=BANK-REF-1', A.viewer))).map((p: any) => p.referenceNumber)).toEqual(['BANK-REF-1']);
      expect((await ok(api.req('get', '/payments?search=%25', A.viewer)))).toEqual([]);
      const open = await ok(api.req('get', '/payments?unallocated=true&limit=100', A.viewer));
      expect(open.length).toBeGreaterThan(0);
      expect(open.every((p: any) => Number(p.unallocatedAmount) > 0 && p.status === 'POSTED')).toBe(true);
      const settled = await ok(api.req('get', '/payments?unallocated=false&limit=100', A.viewer));
      expect(settled.every((p: any) => Number(p.unallocatedAmount) === 0)).toBe(true);
      const day = await ok(api.req('get', '/payments?from=2026-12-02&to=2026-12-02&limit=100', A.viewer));
      expect(day.length).toBe(1);
      const p1 = await api.req('get', '/payments?limit=5&page=1&sort=amount:desc', A.viewer);
      const amounts = p1.body.data.map((p: any) => Number(p.amount));
      expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
    });
  });

  describe('audit and office isolation', () => {
    it('audits receipts, allocations, reversals and cancellations', async () => {
      const actions = [...new Set((await api.prisma.auditLog.findMany({ where: { tenantId: A.tenantId } })).map((l) => l.action))];
      expect(actions).toEqual(expect.arrayContaining(['PAYMENT_RECEIVED', 'PAYMENT_ALLOCATED', 'ALLOCATION_REVERSED', 'PAYMENT_CANCELLED', 'REFUND_PAID']));
      const log = await api.prisma.auditLog.findFirstOrThrow({ where: { tenantId: A.tenantId, action: 'PAYMENT_RECEIVED' }, orderBy: { createdAt: 'asc' } });
      expect(log.afterData).toMatchObject({ type: 'CLIENT_ADVANCE', amount: '1000.0000', currency: 'USD', baseAmount: '1000.0000' });
    });

    it('keeps payments, invoices and cash accounts of one office out of reach of another', async () => {
      const bInvDraft = await ok(api.req('post', '/invoices', B.accountant).send({ clearanceFileId: B.fileId, items: [{ description: 'B fee', categoryId: B.cat[CAT.SERVICE], unitPrice: '50' }] }));
      const bInv = await ok(api.req('post', `/invoices/${bInvDraft.id}/issue`, B.accountant).send({ issueDate: '2026-11-05' }));
      const bPay = await ok(api.req('post', '/payments', B.accountant).send({ clientId: B.clientId, paymentType: 'CLIENT_PAYMENT', amount: '50', currencyCode: 'USD', cashAccountId: B.cash.usd, paymentMethod: 'CASH' }));
      for (const [m, p, body] of [
        ['get', `/payments/${bPay.id}`, undefined], ['post', `/payments/${bPay.id}/allocate`, { allocations: [{ invoiceId: bInv.id, amount: '10' }] }],
        ['post', `/payments/${bPay.id}/cancel`, { reason: 'sabotage' }],
      ] as const) expect((await api.req(m, p, A.accountant).send(body)).status, `${m} ${p}`).toBe(404);
      const aPay = await ok(pay({ amount: '10' }));
      expect((await allocate(aPay.id, [{ invoiceId: bInv.id, amount: '10' }])).body.error.code).toBe('INVOICE_NOT_FOUND'); // B's invoice
      expect((await api.req('post', '/payments', B.accountant).send({ clientId: B.clientId, paymentType: 'CLIENT_PAYMENT', amount: '5', currencyCode: 'USD', cashAccountId: A.cash.usd, paymentMethod: 'CASH' })).body.error.code).toBe('CASH_ACCOUNT_NOT_FOUND');
      expect((await api.req('post', '/payments', B.accountant).send({ clientId: A.clientId, paymentType: 'CLIENT_PAYMENT', amount: '5', currencyCode: 'USD', cashAccountId: B.cash.usd, paymentMethod: 'CASH' })).body.error.code).toBe('CLIENT_NOT_FOUND');
      expect((await ok(api.req('get', '/payments?limit=100', A.accountant))).some((p: any) => p.id === bPay.id)).toBe(false);
      expect((await trialBalance(api, B.accountant)).balance('2100')).toBe('50.0000'); // B has only its own 50
    });
  });
});
