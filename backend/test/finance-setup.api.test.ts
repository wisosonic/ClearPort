import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, provision, signIn, startApi, type TestApi } from './api-helpers';

const YEAR = new Date().getUTCFullYear();

describe('finance foundations API', () => {
  let api: TestApi;
  let A: string; // owner A (USD base)
  let B: string; // owner B
  let accountant: string;
  let officer: string;
  let viewer: string;
  let tenantAId: string;

  const ok = async (p: any) => {
    const res = await p;
    if (res.status >= 300) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const rate = (token: string, body: Record<string, unknown>) => api.req('post', '/exchange-rates', token).send(body);
  const journal = (token: string, body: Record<string, unknown>) => api.req('post', '/accounting/journal-entries', token).send(body);

  beforeAll(async () => {
    api = await startApi();
    const a = await provision(api, 'fin-a', 'owner@fin-a.test');
    await provision(api, 'fin-b', 'owner@fin-b.test');
    tenantAId = a.tenantId;
    A = (await signIn(api, 'owner@fin-a.test')).accessToken;
    B = (await signIn(api, 'owner@fin-b.test')).accessToken;
    await createUser(api, A, 'acct@fin-a.test', 'ACCOUNTANT');
    await createUser(api, A, 'officer@fin-a.test', 'CLEARANCE_OFFICER');
    await createUser(api, A, 'viewer@fin-a.test', 'VIEWER');
    accountant = (await signIn(api, 'acct@fin-a.test')).accessToken;
    officer = (await signIn(api, 'officer@fin-a.test')).accessToken;
    viewer = (await signIn(api, 'viewer@fin-a.test')).accessToken;
  });
  afterAll(async () => api.close());

  describe('currencies and exchange rates', () => {
    it('lists the active currencies', async () => {
      const cur = await ok(api.req('get', '/currencies', viewer));
      expect(cur.map((c: any) => c.code)).toEqual(expect.arrayContaining(['USD', 'LBP', 'EUR']));
      expect(cur.find((c: any) => c.code === 'LBP')).toMatchObject({ decimalPlaces: 0 });
    });

    it('lists the payment methods with both names', async () => {
      const methods = await ok(api.req('get', '/payment-methods', viewer));
      expect(methods.map((m: any) => m.code)).toEqual(['BANK_TRANSFER', 'CARD', 'CASH', 'CHEQUE', 'OTHER']);
      expect(methods.find((m: any) => m.code === 'CASH')).toEqual({ code: 'CASH', nameEn: 'Cash', nameAr: 'نقداً' });
    });

    it('stores LBP as foreign-per-base (exact) and EUR as base-per-foreign by default', async () => {
      const lbp = await ok(rate(accountant, { currency: 'LBP', rate: '89500', effectiveAt: '2026-10-01T00:00:00Z', source: 'sayrafa' }));
      expect(lbp).toMatchObject({ fromCurrency: 'LBP', toCurrency: 'USD', rate: '89500.0000000000', convention: 'FOREIGN_PER_BASE', source: 'sayrafa' });
      const eur = await ok(rate(accountant, { currency: 'EUR', rate: '1.0850', effectiveAt: '2026-10-01T00:00:00Z' }));
      expect(eur).toMatchObject({ rate: '1.0850000000', convention: 'BASE_PER_FOREIGN', source: 'MANUAL_ENTRY' });
      // the convention can be overridden explicitly
      const explicit = await ok(rate(accountant, { currency: 'AED', rate: '3.6725', convention: 'FOREIGN_PER_BASE' }));
      expect(explicit.convention).toBe('FOREIGN_PER_BASE');
    });

    it('resolves the latest rate on or before a date, and never invents one', async () => {
      await ok(rate(accountant, { currency: 'LBP', rate: '90000', effectiveAt: '2026-11-01T00:00:00Z' }));
      const at = async (date: string) => api.req('get', `/exchange-rates/latest?currency=LBP&date=${date}`, officer);
      expect((await ok(at('2026-10-15'))).rate).toBe('89500.0000000000');
      expect((await ok(at('2026-11-02'))).rate).toBe('90000.0000000000');
      const early = await at('2026-09-01');
      expect(early.status).toBe(422);
      expect(early.body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
      expect(early.body.error.details[0]).toMatchObject({ currency: 'LBP', baseCurrency: 'USD' });
      // the base currency is always 1
      expect(await ok(api.req('get', '/exchange-rates/latest?currency=USD', officer))).toMatchObject({ rate: '1.0000000000', source: 'BASE' });
      // a currency with no rate at all
      expect((await api.req('get', '/exchange-rates/latest?currency=GBP', officer)).body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    });

    it('is append-only: corrections are new rows, history is kept', async () => {
      const rows = await ok(api.req('get', '/exchange-rates?currency=LBP', officer));
      expect(rows.map((r: any) => r.rate)).toEqual(['90000.0000000000', '89500.0000000000']); // newest first
      expect((await rate(accountant, { currency: 'LBP', rate: '90100', effectiveAt: '2026-11-01T00:00:00Z' })).body.error.code).toBe('EXCHANGE_RATE_EXISTS');
      expect(await api.prisma.exchangeRate.count({ where: { tenantId: tenantAId, fromCurrency: 'LBP' } })).toBe(2);
    });

    it('validates input and permissions', async () => {
      expect((await rate(accountant, { currency: 'USD', rate: '1' })).body.error.code).toBe('BASE_CURRENCY_NEEDS_NO_RATE');
      expect((await rate(accountant, { currency: 'ZZZ', rate: '2' })).body.error.code).toBe('CURRENCY_NOT_FOUND');
      expect((await rate(accountant, { currency: 'EUR', rate: '0' })).status).toBe(400);
      expect((await rate(accountant, { currency: 'EUR', rate: '-1' })).status).toBe(400);
      expect((await rate(accountant, { currency: 'EUR', rate: 'abc' })).status).toBe(400);
      expect((await rate(officer, { currency: 'EUR', rate: '1.1' })).status).toBe(403);
      expect((await rate(viewer, { currency: 'EUR', rate: '1.1' })).status).toBe(403);
      expect((await api.req('get', '/exchange-rates', viewer)).status).toBe(200);
    });

    it('keeps each office\'s rates private', async () => {
      expect(await ok(api.req('get', '/exchange-rates', B))).toEqual([]);
      expect((await api.req('get', '/exchange-rates/latest?currency=LBP', B)).body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
    });
  });

  describe('manual journal entries and the ledger', () => {
    it('posts a balanced entry with a gapless number and shows balanced totals', async () => {
      const e = await ok(journal(accountant, {
        entryDate: '2026-11-03', description: 'Opening cash', lines: [
          { accountCode: '1010', debit: '1000', currencyCode: 'USD' }, { accountCode: '3000', credit: '1000', currencyCode: 'USD' },
        ],
      }));
      expect(e).toMatchObject({ entryNumber: `JE-2026-00001`, status: 'POSTED', sourceType: 'MANUAL', totals: { baseDebit: '1000.0000', baseCredit: '1000.0000' } });
      expect(e.lines.map((l: any) => [l.accountCode, l.debit, l.credit])).toEqual(expect.arrayContaining([['1010', '1000.0000', '0.0000'], ['3000', '0.0000', '1000.0000']]));
      const next = await ok(journal(accountant, {
        entryDate: '2026-11-03', description: 'Second', lines: [{ accountCode: '1010', debit: '1', currencyCode: 'USD' }, { accountCode: '3000', credit: '1', currencyCode: 'USD' }],
      }));
      expect(next.entryNumber).toBe('JE-2026-00002');
    });

    it('converts foreign-currency lines at the rate in force and balances in base currency', async () => {
      const e = await ok(journal(accountant, {
        entryDate: '2026-10-20', description: 'LBP cash received', lines: [
          { accountCode: '1020', debit: '89500000', currencyCode: 'LBP' }, { accountCode: '4200', credit: '1000', currencyCode: 'USD' },
        ],
      }));
      const lbp = e.lines.find((l: any) => l.accountCode === '1020');
      expect(lbp).toMatchObject({ currencyCode: 'LBP', debit: '89500000.0000', exchangeRate: '89500.0000000000', rateConvention: 'FOREIGN_PER_BASE', baseDebit: '1000.0000' });
      expect(e.totals).toEqual({ baseDebit: '1000.0000', baseCredit: '1000.0000' });
      // an explicit rate on the line overrides the table and is recorded as such
      const manual = await ok(journal(accountant, {
        entryDate: '2026-10-20', description: 'Agreed rate', lines: [
          { accountCode: '1020', debit: '90000000', currencyCode: 'LBP', exchangeRate: '90000', rateConvention: 'FOREIGN_PER_BASE' },
          { accountCode: '4200', credit: '1000', currencyCode: 'USD' },
        ],
      }));
      expect(manual.lines.find((l: any) => l.accountCode === '1020').baseDebit).toBe('1000.0000');
    });

    it('rejects unbalanced entries, bad lines and unknown accounts with clear errors', async () => {
      const unbalanced = await journal(accountant, {
        entryDate: '2026-11-03', description: 'Oops', lines: [{ accountCode: '1010', debit: '100', currencyCode: 'USD' }, { accountCode: '3000', credit: '99.9999', currencyCode: 'USD' }],
      });
      expect(unbalanced.status).toBe(422);
      expect(unbalanced.body.error.code).toBe('JOURNAL_NOT_BALANCED');
      expect(unbalanced.body.error.details[0]).toEqual({ debits: '100.0000', credits: '99.9999' });
      const both = await journal(accountant, { entryDate: '2026-11-03', description: 'Both', lines: [{ accountCode: '1010', debit: '1', credit: '1', currencyCode: 'USD' }, { accountCode: '3000', credit: '1', currencyCode: 'USD' }] });
      expect(both.status).toBe(400);
      const neither = await journal(accountant, { entryDate: '2026-11-03', description: 'Neither', lines: [{ accountCode: '1010', currencyCode: 'USD' }, { accountCode: '3000', credit: '1', currencyCode: 'USD' }] });
      expect(neither.status).toBe(400);
      expect((await journal(accountant, { entryDate: '2026-11-03', description: 'One line', lines: [{ accountCode: '1010', debit: '1', currencyCode: 'USD' }] })).status).toBe(400);
      expect((await journal(accountant, { entryDate: '2026-11-03', description: 'Negative', lines: [{ accountCode: '1010', debit: '-1', currencyCode: 'USD' }, { accountCode: '3000', credit: '1', currencyCode: 'USD' }] })).status).toBe(400);
      const unknown = await journal(accountant, { entryDate: '2026-11-03', description: 'Unknown account', lines: [{ accountCode: '9999', debit: '1', currencyCode: 'USD' }, { accountCode: '3000', credit: '1', currencyCode: 'USD' }] });
      expect(unknown.status).toBe(422);
      expect(unknown.body.error.code).toBe('LEDGER_ACCOUNT_NOT_FOUND');
      expect((await journal(accountant, { entryDate: '2026-11-03', description: 'No rate', lines: [{ accountCode: '1010', debit: '5', currencyCode: 'GBP' }, { accountCode: '3000', credit: '5', currencyCode: 'USD' }] })).body.error.code).toBe('EXCHANGE_RATE_REQUIRED');
      expect((await journal(accountant, { entryDate: 'yesterday', description: 'Bad date', lines: [] })).status).toBe(400);
    });

    it('requires accounting.post to post and accounting.view to read', async () => {
      const body = { entryDate: '2026-11-03', description: 'Nope', lines: [{ accountCode: '1010', debit: '1', currencyCode: 'USD' }, { accountCode: '3000', credit: '1', currencyCode: 'USD' }] };
      expect((await journal(officer, body)).status).toBe(403);
      expect((await journal(viewer, body)).status).toBe(403);
      expect((await api.req('get', '/accounting/journal-entries', officer)).status).toBe(403);
      expect((await api.req('get', '/accounting/journal-entries', accountant)).status).toBe(200);
      // the Viewer role is read-only access to everything, accounting included
      expect((await api.req('get', '/accounting/trial-balance', viewer)).status).toBe(200);
      expect((await api.req('get', '/accounting/trial-balance', officer)).status).toBe(403);
    });

    it('reverses a manual entry with a mirror entry; both stay, balances net to zero', async () => {
      const e = await ok(journal(accountant, { entryDate: '2026-11-03', description: 'Mistake', lines: [{ accountCode: '1010', debit: '250', currencyCode: 'USD' }, { accountCode: '4200', credit: '250', currencyCode: 'USD' }] }));
      const before = (await ok(api.req('get', '/accounting/trial-balance', accountant))).lines.find((l: any) => l.accountCode === '4200').balance;
      const rev = await api.req('post', `/accounting/journal-entries/${e.id}/reverse`, accountant).send({ reason: 'Wrong account' });
      expect(rev.status).toBe(200);
      expect(rev.body.data).toMatchObject({ status: 'POSTED', sourceType: 'REVERSAL', reversalOfId: e.id });
      expect(rev.body.data.description).toBe(`Reversal of ${e.entryNumber}: Wrong account`);
      expect(rev.body.data.lines.find((l: any) => l.accountCode === '1010')).toMatchObject({ debit: '0.0000', credit: '250.0000' });
      expect((await ok(api.req('get', `/accounting/journal-entries/${e.id}`, accountant))).status).toBe('REVERSED');
      const after = (await ok(api.req('get', '/accounting/trial-balance', accountant))).lines.find((l: any) => l.accountCode === '4200').balance;
      expect(Number(before) - Number(after)).toBe(250); // the 250 revenue is gone again
      expect((await api.req('post', `/accounting/journal-entries/${e.id}/reverse`, accountant).send({ reason: 'again' })).body.error.code).toBe('JOURNAL_ENTRY_NOT_REVERSIBLE');
      expect((await api.req('post', `/accounting/journal-entries/${rev.body.data.id}/reverse`, accountant).send({ reason: 'reverse the reversal' })).body.error.code).toBe('JOURNAL_ENTRY_SOURCE_MANAGED');
      expect((await api.req('post', `/accounting/journal-entries/${e.id}/reverse`, accountant).send({ reason: 'x' })).status).toBe(400);
      expect((await api.req('post', `/accounting/journal-entries/${e.id}/reverse`, officer).send({ reason: 'not allowed' })).status).toBe(403);
    });

    it('refuses to reverse a system-generated entry directly (the record must be cancelled instead)', async () => {
      const e = await api.prisma.journalEntry.create({
        data: { tenantId: tenantAId, entryNumber: 'JE-SYS-1', entryDate: new Date(), description: 'from an invoice', sourceType: 'INVOICE', sourceId: 'x', createdBy: (await api.prisma.user.findFirstOrThrow()).id },
      });
      const res = await api.req('post', `/accounting/journal-entries/${e.id}/reverse`, accountant).send({ reason: 'let me fix it' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('JOURNAL_ENTRY_SOURCE_MANAGED');
      await api.prisma.journalEntry.delete({ where: { id: e.id } }); // draft: deletable
    });

    it('lists and filters entries, and the trial balance always balances', async () => {
      const all = await api.req('get', '/accounting/journal-entries?limit=100', accountant);
      expect(all.body.meta.total).toBeGreaterThanOrEqual(5);
      expect(all.body.data.every((e: any) => e.totals.baseDebit === e.totals.baseCredit)).toBe(true);
      const reversed = await ok(api.req('get', '/accounting/journal-entries?status=REVERSED', accountant));
      expect(reversed.every((e: any) => e.status === 'REVERSED')).toBe(true);
      expect((await ok(api.req('get', '/accounting/journal-entries?sourceType=reversal', accountant))).every((e: any) => e.sourceType === 'REVERSAL')).toBe(true);
      expect((await ok(api.req('get', '/accounting/journal-entries?accountCode=1020', accountant))).length).toBe(2);
      expect((await ok(api.req('get', '/accounting/journal-entries?search=Opening cash', accountant))).map((e: any) => e.description)).toEqual(['Opening cash']);
      expect((await ok(api.req('get', '/accounting/journal-entries?search=%25', accountant)))).toEqual([]);
      expect((await ok(api.req('get', '/accounting/journal-entries?from=2026-10-20&to=2026-10-20', accountant))).length).toBe(2);

      const tb = await ok(api.req('get', '/accounting/trial-balance', accountant));
      expect(tb.balanced).toBe(true);
      expect(tb.totals.debit).toBe(tb.totals.credit);
      expect(tb.baseCurrency).toBe('USD');
      const cash = tb.lines.find((l: any) => l.accountCode === '1010');
      expect(cash).toMatchObject({ accountType: 'ASSET' });
      const earlier = await ok(api.req('get', '/accounting/trial-balance?asOf=2026-10-31', accountant));
      expect(earlier.lines.find((l: any) => l.accountCode === '1010')).toBeUndefined(); // nothing in 1010 before November
      expect(earlier.balanced).toBe(true);
    });

    it('keeps each office\'s ledger separate', async () => {
      expect((await ok(api.req('get', '/accounting/trial-balance', B))).lines).toEqual([]);
      const mine = (await ok(api.req('get', '/accounting/journal-entries?limit=100', accountant)))[0];
      expect((await api.req('get', `/accounting/journal-entries/${mine.id}`, B)).status).toBe(404);
      expect((await api.req('post', `/accounting/journal-entries/${mine.id}/reverse`, B).send({ reason: 'hacking it' })).status).toBe(404);
    });
  });

  describe('chart of accounts', () => {
    it('lists the seeded chart including the FX account', async () => {
      const accounts = await ok(api.req('get', '/accounting/accounts', accountant));
      const codes = accounts.map((a: any) => a.accountCode);
      expect(codes).toEqual(expect.arrayContaining(['1010', '1020', '1200', '1300', '2100', '2200', '2300', '4100', '4300', '5100']));
      expect(accounts.find((a: any) => a.accountCode === '2100')).toMatchObject({ name: 'Client advances (liability)', accountType: 'LIABILITY' });
    });

    it('adds custom accounts and guards system ones', async () => {
      const acc = await ok(api.req('post', '/accounting/accounts', accountant).send({ accountCode: '5300', name: 'Bank charges', accountType: 'EXPENSE' }));
      expect(acc.isActive).toBe(true);
      expect((await api.req('post', '/accounting/accounts', accountant).send({ accountCode: '5300', name: 'Dup', accountType: 'EXPENSE' })).body.error.code).toBe('ACCOUNT_CODE_TAKEN');
      expect((await api.req('post', '/accounting/accounts', accountant).send({ accountCode: '5400', name: 'Bad parent', accountType: 'EXPENSE', parentId: '00000000-0000-4000-8000-000000000000' })).body.error.code).toBe('PARENT_ACCOUNT_NOT_FOUND');
      expect((await api.req('post', '/accounting/accounts', accountant).send({ accountCode: 'ABC', name: 'Letters', accountType: 'EXPENSE' })).status).toBe(400);

      const system = (await ok(api.req('get', '/accounting/accounts', accountant))).find((a: any) => a.accountCode === '2100');
      expect((await api.req('patch', `/accounting/accounts/${system.id}`, accountant).send({ isActive: false })).body.error.code).toBe('SYSTEM_ACCOUNT');

      // a used account cannot be deactivated; an empty one can, and then nothing may post to it
      await ok(journal(accountant, { entryDate: '2026-11-03', description: 'Bank fee', lines: [{ accountCode: '5300', debit: '5', currencyCode: 'USD' }, { accountCode: '1010', credit: '5', currencyCode: 'USD' }] }));
      expect((await api.req('patch', `/accounting/accounts/${acc.id}`, accountant).send({ isActive: false })).body.error.code).toBe('ACCOUNT_HAS_BALANCE');
      const empty = await ok(api.req('post', '/accounting/accounts', accountant).send({ accountCode: '5310', name: 'Unused', accountType: 'EXPENSE' }));
      expect((await api.req('patch', `/accounting/accounts/${empty.id}`, accountant).send({ isActive: false })).body.data.isActive).toBe(false);
      const inactive = await journal(accountant, { entryDate: '2026-11-03', description: 'To inactive', lines: [{ accountCode: '5310', debit: '1', currencyCode: 'USD' }, { accountCode: '1010', credit: '1', currencyCode: 'USD' }] });
      expect(inactive.status).toBe(422);
      expect(inactive.body.error.code).toBe('LEDGER_ACCOUNT_INACTIVE');
      expect((await api.req('post', '/accounting/accounts', officer).send({ accountCode: '5500', name: 'No', accountType: 'EXPENSE' })).status).toBe(403);
    });
  });

  describe('cash accounts', () => {
    it('shows balances derived from the ledger, in each account\'s own currency', async () => {
      const accounts = await ok(api.req('get', '/cash-accounts', accountant));
      const usd = accounts.find((a: any) => a.name === 'USD cashbox');
      const lbp = accounts.find((a: any) => a.name === 'LBP cashbox');
      // +1000 +1 opening, -5 fee, +250 -250 reversed = 996
      expect(usd).toMatchObject({ currencyCode: 'USD', ledgerAccountCode: '1010', balance: '996.0000' });
      expect(lbp).toMatchObject({ currencyCode: 'LBP', ledgerAccountCode: '1020', balance: '179500000.0000' }); // 89.5m + 90m LBP received
    });

    it('creates a bank account with its own ledger account and keeps names unique', async () => {
      const bank = await ok(api.req('post', '/cash-accounts', accountant).send({ name: 'BLOM USD', accountType: 'BANK', currencyCode: 'USD' }));
      expect(bank).toMatchObject({ name: 'BLOM USD', accountType: 'BANK', currencyCode: 'USD', balance: '0.0000', ledgerAccountCode: '1040' });
      const second = await ok(api.req('post', '/cash-accounts', accountant).send({ name: 'Byblos EUR', accountType: 'BANK', currencyCode: 'EUR' }));
      expect(second.ledgerAccountCode).toBe('1050');
      expect((await api.req('post', '/cash-accounts', accountant).send({ name: 'BLOM USD', accountType: 'BANK', currencyCode: 'USD' })).body.error.code).toBe('CASH_ACCOUNT_NAME_TAKEN');
      expect((await api.req('post', '/cash-accounts', accountant).send({ name: 'Weird', accountType: 'BANK', currencyCode: 'ZZZ' })).body.error.code).toBe('CURRENCY_NOT_FOUND');
      expect((await api.req('post', '/cash-accounts', officer).send({ name: 'Nope', accountType: 'BANK', currencyCode: 'USD' })).status).toBe(403);
      const ledger = (await ok(api.req('get', '/accounting/accounts', accountant))).find((a: any) => a.accountCode === '1040');
      expect(ledger).toMatchObject({ accountType: 'ASSET', currencyCode: 'USD' });
    });

    it('renames, and deactivates only when empty', async () => {
      const usd = (await ok(api.req('get', '/cash-accounts', accountant))).find((a: any) => a.name === 'USD cashbox');
      expect((await api.req('patch', `/cash-accounts/${usd.id}`, accountant).send({ isActive: false })).body.error.code).toBe('CASH_ACCOUNT_HAS_BALANCE');
      const bank = (await ok(api.req('get', '/cash-accounts', accountant))).find((a: any) => a.name === 'Byblos EUR');
      expect((await ok(api.req('patch', `/cash-accounts/${bank.id}`, accountant).send({ name: 'Byblos EUR (old)' }))).name).toBe('Byblos EUR (old)');
      expect((await ok(api.req('patch', `/cash-accounts/${bank.id}`, accountant).send({ isActive: false }))).isActive).toBe(false);
      expect((await ok(api.req('get', '/cash-accounts', accountant))).some((a: any) => a.id === bank.id)).toBe(false);
      expect((await ok(api.req('get', '/cash-accounts?includeInactive=true', accountant))).some((a: any) => a.id === bank.id)).toBe(true);
    });

    it('is visible to payment viewers only, and per office', async () => {
      expect((await api.req('get', '/cash-accounts', viewer)).status).toBe(200);
      expect((await ok(api.req('get', '/cash-accounts', B))).map((a: any) => a.balance)).toEqual(['0.0000', '0.0000']);
    });
  });

  describe('financial categories', () => {
    it('lists the seeded categories with their accounting treatment', async () => {
      const cats = await ok(api.req('get', '/financial-categories', officer));
      expect(cats).toHaveLength(9);
      const duties = cats.find((c: any) => c.name === 'Customs duties and taxes');
      expect(duties).toMatchObject({ costTreatment: 'PASS_THROUGH', isBillableToClient: true, isTaxable: false });
      expect(cats.find((c: any) => c.name === 'Clearance service fees')).toMatchObject({ costTreatment: 'OFFICE_REVENUE', isTaxable: true });
      expect(cats.find((c: any) => c.name === 'Office expenses (non-billable)')).toMatchObject({ costTreatment: 'OFFICE_EXPENSE', isBillableToClient: false });
    });

    it('lets administrators add and adjust categories, but not change what they mean', async () => {
      const cat = await ok(api.req('post', '/financial-categories', A).send({ name: 'Fumigation', categoryType: 'OTHER', costTreatment: 'PASS_THROUGH' }));
      expect(cat).toMatchObject({ isBillableToClient: true, isTaxable: false, isActive: true });
      expect((await api.req('post', '/financial-categories', A).send({ name: 'Fumigation', categoryType: 'OTHER', costTreatment: 'PASS_THROUGH' })).body.error.code).toBe('CATEGORY_NAME_TAKEN');
      const upd = await ok(api.req('patch', `/financial-categories/${cat.id}`, A).send({ isTaxable: true, name: 'Fumigation service' }));
      expect(upd).toMatchObject({ isTaxable: true, name: 'Fumigation service' });
      expect((await api.req('patch', `/financial-categories/${cat.id}`, A).send({ costTreatment: 'OFFICE_REVENUE' })).status).toBe(400);
      expect((await api.req('patch', `/financial-categories/${cat.id}`, A).send({ name: 'Port fees' })).body.error.code).toBe('CATEGORY_NAME_TAKEN');
      expect((await api.req('post', '/financial-categories', accountant).send({ name: 'Nope', categoryType: 'OTHER', costTreatment: 'PASS_THROUGH' })).status).toBe(403);
      expect((await ok(api.req('get', '/financial-categories?includeInactive=true', A))).length).toBe(10);
      expect((await ok(api.req('get', '/financial-categories', B))).some((c: any) => c.name.startsWith('Fumigation'))).toBe(false);
    });
  });

  describe('tax settings', () => {
    it('is off by default and entered by the office, never hardcoded', async () => {
      expect(await ok(api.req('get', '/settings/tax', officer))).toEqual({ enabled: false, name: 'VAT', ratePercent: '0.0000' });
      const put = await ok(api.req('put', '/settings/tax', A).send({ enabled: true, name: 'VAT', ratePercent: '11' }));
      expect(put).toEqual({ enabled: true, name: 'VAT', ratePercent: '11.0000' });
      expect(await ok(api.req('get', '/settings/tax', viewer))).toEqual(put);
      // other offices are unaffected
      expect(await ok(api.req('get', '/settings/tax', B))).toMatchObject({ enabled: false });
    });

    it('validates the rate and requires settings.manage', async () => {
      expect((await api.req('put', '/settings/tax', A).send({ enabled: true, ratePercent: '101' })).status).toBe(400);
      expect((await api.req('put', '/settings/tax', A).send({ enabled: true, ratePercent: '-1' })).status).toBe(400);
      expect((await api.req('put', '/settings/tax', A).send({ enabled: true, ratePercent: 'abc' })).status).toBe(400);
      expect((await api.req('put', '/settings/tax', accountant).send({ enabled: true, ratePercent: '11' })).status).toBe(403);
      const again = await ok(api.req('put', '/settings/tax', A).send({ enabled: true, name: 'TVA', ratePercent: '11.5' }));
      expect(again).toMatchObject({ name: 'TVA', ratePercent: '11.5000' });
    });

    it('audits every change with before and after', async () => {
      const logs = await api.prisma.auditLog.findMany({ where: { action: 'TAX_SETTINGS_CHANGED', tenantId: tenantAId }, orderBy: { createdAt: 'asc' } });
      expect(logs.length).toBe(2);
      expect(logs[1].beforeData).toMatchObject({ ratePercent: '11.0000' });
      expect(logs[1].afterData).toMatchObject({ ratePercent: '11.5000', name: 'TVA' });
    });
  });
});
