import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApi, type TestApi } from './api-helpers';
import { CAT, financeOffice, ok, trialBalance, type FinanceOffice } from './finance-helpers';

describe('foreign-exchange revaluation', () => {
  let api: TestApi;
  let A: FinanceOffice;
  let B: FinanceOffice;
  let invoiceId: string;

  const revalue = (body: Record<string, unknown>, token = A.accountant) => api.req('post', '/accounting/revaluation', token).send(body);
  const bal = async (code: string) => (await trialBalance(api, A.accountant)).balance(code);

  beforeAll(async () => {
    api = await startApi();
    A = await financeOffice(api, 'reval-a');
    B = await financeOffice(api, 'reval-b');
    // an LBP invoice of 89,500,000 LBP issued at 89,500 per USD: carried at 1,000 USD
    const d = await ok(api.req('post', '/invoices', A.accountant).send({
      clearanceFileId: A.fileId, currencyCode: 'LBP', items: [{ description: 'Clearance fee', categoryId: A.cat[CAT.SERVICE], unitPrice: '89500000' }],
    }));
    invoiceId = (await ok(api.req('post', `/invoices/${d.id}/issue`, A.accountant).send({ issueDate: '2026-11-05' }))).id;
    await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'LBP', rate: '100000', effectiveAt: '2026-12-01T00:00:00Z', source: 'test' }));
    await ok(api.req('post', '/exchange-rates', A.accountant).send({ currency: 'LBP', rate: '80000', effectiveAt: '2027-01-15T00:00:00Z', source: 'test' }));
  });
  afterAll(async () => api.close());

  it('previews the difference without posting anything', async () => {
    const before = await bal('1200');
    const res = await ok(revalue({ asOf: '2026-12-31', preview: true }));
    expect(res.entry).toBeNull();
    expect(res.adjustments).toEqual([expect.objectContaining({ accountCode: '1200', currency: 'LBP', foreignBalance: '89500000.0000', carriedBase: '1000.0000', revaluedBase: '895.0000', difference: '-105.0000' })]);
    expect(res.netGainLoss).toBe('-105.0000');
    expect(await bal('1200')).toBe(before);
  });

  it('books an unrealised loss when the pound weakens, leaving the invoice itself untouched', async () => {
    const res = await ok(revalue({ asOf: '2026-12-31' }));
    expect(res.entry.entryNumber).toMatch(/^JE-/);
    expect(await bal('1200')).toBe('895.0000');
    const tb = await trialBalance(api, A.accountant);
    expect(tb.balanced).toBe(true);
    expect(tb.byCode['4300']).toMatchObject({ debit: '105.0000', credit: '0.0000' }); // a loss
    const inv = await ok(api.req('get', `/invoices/${invoiceId}`, A.owner));
    expect(inv).toMatchObject({ totalAmount: '89500000.0000', outstandingAmount: '89500000.0000', baseTotalAmount: '1000.0000' });
    const entries = await ok(api.req('get', '/accounting/journal-entries?sourceType=FX_REVALUATION', A.accountant));
    expect(entries).toHaveLength(1);
    const detail = await ok(api.req('get', `/accounting/journal-entries/${entries[0].id}`, A.accountant));
    expect(detail.lines.find((l: any) => l.accountCode === '1200')).toMatchObject({ currencyCode: 'LBP', credit: '0.0000', baseCredit: '105.0000' });
  });

  it('is repeatable: nothing to book until a rate changes, then only the new difference', async () => {
    const again = await ok(revalue({ asOf: '2026-12-31' }));
    expect(again.adjustments).toEqual([]);
    expect(again.entry).toBeNull();
    const later = await ok(revalue({ asOf: '2027-01-31' })); // 89.5M at 80,000 = 1,118.75
    expect(later.adjustments[0]).toMatchObject({ carriedBase: '895.0000', revaluedBase: '1118.7500', difference: '223.7500' });
    expect(await bal('1200')).toBe('1118.7500');
    expect((await trialBalance(api, A.accountant)).byCode['4300']).toMatchObject({ debit: '105.0000', credit: '223.7500' });
  });

  it('cannot be undone by hand like a manual entry, and needs accounting.post', async () => {
    const [entry] = await ok(api.req('get', '/accounting/journal-entries?sourceType=FX_REVALUATION&limit=1', A.accountant));
    expect((await api.req('post', `/accounting/journal-entries/${entry.id}/reverse`, A.accountant).send({ reason: 'oops' })).body.error.code).toBe('JOURNAL_ENTRY_SOURCE_MANAGED');
    expect((await revalue({}, A.officer)).status).toBe(403);
    expect((await revalue({}, A.viewer)).status).toBe(403);
    expect((await revalue({ asOf: 'nope' })).status).toBe(400);
  });

  it('only ever touches its own office', async () => {
    const res = await ok(revalue({ asOf: '2027-01-31' }, B.accountant));
    expect(res.adjustments).toEqual([]);
    expect((await trialBalance(api, B.accountant)).byCode['4300']).toBeUndefined();
  });
});
