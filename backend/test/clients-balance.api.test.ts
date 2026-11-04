import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { provision, signIn, startApi, type TestApi } from './api-helpers';

/**
 * Client balance / statement are read-only views over invoices, payments and allocations.
 * The finance write-APIs come later (Phase 5), so this test inserts those rows directly.
 *
 * Worked example (USD):
 *   10-01  invoice INV-1            1,000.00   (debit)
 *   10-05  advance PAY-1              300.00   (credit)   -> held as a liability until applied
 *   10-10  invoice INV-2              500.00   (debit)
 *   10-12  invoice INV-3 (CANCELLED)  999.00   ignored
 *   10-14  payment PAY-2 DRAFT        111.00   ignored (not posted)
 *   10-15  payment PAY-3              700.00   (credit)   allocated 700 to INV-1
 *   10-20  refund  PAY-4               50.00   (debit)    paid back to the client
 *  LBP: invoice INV-L 89,500,000 (debit), unpaid.
 *
 *  USD  invoiced 1500  received 1000  refunded 50  allocated 700
 *       outstanding = 1500 - 700 = 800;  unapplied credit = 1000 - 50 - 700 = 250;  net = 800 - 250 = 550
 */
describe('client balance and statement', () => {
  let api: TestApi;
  let A: string;
  let B: string;
  let clientId: string;
  let emptyClientId: string;
  let bClientId: string;

  const iso = (d: string) => new Date(`${d}T12:00:00.000Z`);

  beforeAll(async () => {
    api = await startApi();
    const a = await provision(api, 'fin-a', 'owner@fin-a.test');
    await provision(api, 'fin-b', 'owner@fin-b.test');
    A = (await signIn(api, 'owner@fin-a.test')).accessToken;
    B = (await signIn(api, 'owner@fin-b.test')).accessToken;

    clientId = (await api.req('post', '/clients', A).send({ name: 'Ledger Client' })).body.data.id;
    emptyClientId = (await api.req('post', '/clients', A).send({ name: 'Brand new client' })).body.data.id;
    bClientId = (await api.req('post', '/clients', B).send({ name: 'B client' })).body.data.id;

    const p = api.prisma;
    const file = await p.clearanceFile.create({
      data: { tenantId: a.tenantId, fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', clientId, createdBy: a.ownerUserId },
    });
    const usdBox = await p.cashAccount.findFirstOrThrow({ where: { tenantId: a.tenantId, currencyCode: 'USD' } });

    const invoice = (n: string, total: string, date: string, status: 'ISSUED' | 'CANCELLED' = 'ISSUED', cur = 'USD') =>
      p.invoice.create({
        data: {
          tenantId: a.tenantId, clearanceFileId: file.id, clientId, invoiceNumber: n, currencyCode: cur,
          subtotal: total, totalAmount: total, status, issueDate: iso(date), issuedAt: iso(date), createdBy: a.ownerUserId,
        },
      });
    const payment = (n: string, type: any, amount: string, date: string, status: 'POSTED' | 'DRAFT' = 'POSTED') =>
      p.payment.create({
        data: {
          tenantId: a.tenantId, clientId, paymentNumber: n, paymentType: type, amount, currencyCode: 'USD',
          exchangeRate: '1.0000000000', baseAmount: amount, paymentMethod: 'CASH', cashAccountId: usdBox.id,
          paymentDate: iso(date), receivedBy: a.ownerUserId, status,
        },
      });

    const inv1 = await invoice('INV-1', '1000.0000', '2026-10-01');
    await payment('PAY-1', 'CLIENT_ADVANCE', '300.0000', '2026-10-05');
    await invoice('INV-2', '500.0000', '2026-10-10');
    await invoice('INV-3', '999.0000', '2026-10-12', 'CANCELLED');
    await payment('PAY-2', 'CLIENT_PAYMENT', '111.0000', '2026-10-14', 'DRAFT');
    const pay3 = await payment('PAY-3', 'CLIENT_PAYMENT', '700.0000', '2026-10-15');
    await payment('PAY-4', 'REFUND', '50.0000', '2026-10-20');
    await p.paymentAllocation.create({
      data: { tenantId: a.tenantId, paymentId: pay3.id, invoiceId: inv1.id, allocatedAmount: '700.0000', currencyCode: 'USD', paymentAmount: '700.0000' },
    });
    await invoice('INV-L', '89500000.0000', '2026-10-02', 'ISSUED', 'LBP');
  });
  afterAll(async () => api.close());

  it('computes balances per currency, never mixing currencies', async () => {
    const res = await api.req('get', `/clients/${clientId}/balance`, A);
    expect(res.status).toBe(200);
    expect(res.body.data.basis).toBe('TRANSACTION_CURRENCY');
    const byCur = Object.fromEntries(res.body.data.balances.map((b: any) => [b.currency, b]));
    expect(byCur.USD).toEqual({
      currency: 'USD', invoiced: '1500.0000', received: '1000.0000', refunded: '50.0000', allocated: '700.0000',
      outstanding: '800.0000', unappliedCredit: '250.0000', netBalance: '550.0000',
    });
    expect(byCur.LBP).toMatchObject({
      invoiced: '89500000.0000', received: '0.0000', allocated: '0.0000',
      outstanding: '89500000.0000', unappliedCredit: '0.0000', netBalance: '89500000.0000',
    });
  });

  it('ignores cancelled invoices and unposted payments', async () => {
    const usd = (await api.req('get', `/clients/${clientId}/balance`, A)).body.data.balances.find((b: any) => b.currency === 'USD');
    expect(usd.invoiced).toBe('1500.0000'); // 999 cancelled invoice not counted
    expect(usd.received).toBe('1000.0000'); // 111 draft payment not counted
  });

  it('keeps an unallocated advance as unapplied credit (a liability), not as revenue', async () => {
    const usd = (await api.req('get', `/clients/${clientId}/balance`, A)).body.data.balances.find((b: any) => b.currency === 'USD');
    expect(usd.unappliedCredit).toBe('250.0000');
    expect(usd.netBalance).toBe('550.0000'); // = outstanding 800 - credit 250
  });

  it('returns an empty balance for a client with no activity', async () => {
    const res = await api.req('get', `/clients/${emptyClientId}/balance`, A);
    expect(res.body.data.balances).toEqual([]);
  });

  it('builds a chronological statement with a running balance per currency', async () => {
    const res = await api.req('get', `/clients/${clientId}/statement?currency=USD`, A);
    expect(res.status).toBe(200);
    const lines = res.body.data.lines.map((l: any) => [l.date, l.reference, l.type, l.debit, l.credit, l.balance]);
    expect(lines).toEqual([
      ['2026-10-01', 'INV-1', 'INVOICE', '1000.0000', '0.0000', '1000.0000'],
      ['2026-10-05', 'PAY-1', 'PAYMENT', '0.0000', '300.0000', '700.0000'],
      ['2026-10-10', 'INV-2', 'INVOICE', '500.0000', '0.0000', '1200.0000'],
      ['2026-10-15', 'PAY-3', 'PAYMENT', '0.0000', '700.0000', '500.0000'],
      ['2026-10-20', 'PAY-4', 'REFUND', '50.0000', '0.0000', '550.0000'],
    ]);
    expect(res.body.data.closingBalances).toEqual({ USD: '550.0000' });
  });

  it('the statement closing balance equals the balance endpoint net balance (reconciliation)', async () => {
    const stmt = (await api.req('get', `/clients/${clientId}/statement`, A)).body.data;
    const bal = (await api.req('get', `/clients/${clientId}/balance`, A)).body.data.balances;
    for (const b of bal) expect(stmt.closingBalances[b.currency]).toBe(b.netBalance);
  });

  it('supports a date range with an opening balance', async () => {
    const res = await api.req('get', `/clients/${clientId}/statement?currency=USD&from=2026-10-10&to=2026-10-16`, A);
    expect(res.body.data.openingBalances).toEqual({ USD: '700.0000' }); // after INV-1 and PAY-1
    expect(res.body.data.lines.map((l: any) => l.reference)).toEqual(['INV-2', 'PAY-3']);
    expect(res.body.data.lines.map((l: any) => l.balance)).toEqual(['1200.0000', '500.0000']);
    expect((await api.req('get', `/clients/${clientId}/statement?from=10/10/2026`, A)).status).toBe(400);
  });

  it('keeps other offices\' financial data out entirely', async () => {
    expect((await api.req('get', `/clients/${bClientId}/balance`, A)).status).toBe(404);
    expect((await api.req('get', `/clients/${bClientId}/statement`, A)).status).toBe(404);
    expect((await api.req('get', `/clients/${bClientId}/balance`, B)).body.data.balances).toEqual([]);
    expect((await api.req('get', `/clients/${clientId}/balance`, B)).status).toBe(404);
  });

  it('lists a client\'s files with search and filters', async () => {
    const res = await api.req('get', `/clients/${clientId}/files`, A);
    expect(res.body.meta.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status: 'OPEN' });
    expect(Object.keys(res.body.data[0])).not.toContain('internalNotes');
    expect((await api.req('get', `/clients/${clientId}/files?status=CLOSED`, A)).body.data).toEqual([]);
    expect((await api.req('get', `/clients/${clientId}/files?search=00001`, A)).body.data).toHaveLength(1);
    expect((await api.req('get', `/clients/${bClientId}/files`, A)).status).toBe(404);
  });
});
