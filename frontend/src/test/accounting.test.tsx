import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { setLocale } from '@/i18n';
import { App } from '@/app/App';
import { createTestRouter } from '@/app/router';
import { tokens } from '@/lib/api-client';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => res(200, { success: true, data, meta });
const fail = (status: number, code: string, message: string) => res(status, { success: false, error: { code, message, details: [] } });

const line = (id: string, code: string, name: string, side: 'debit' | 'credit', amount: string, cur = 'USD') => ({
  id, accountCode: code, accountName: name, currencyCode: cur, debit: side === 'debit' ? amount : '0.0000', credit: side === 'credit' ? amount : '0.0000',
  baseDebit: side === 'debit' ? amount : '0.0000', baseCredit: side === 'credit' ? amount : '0.0000', clearanceFileId: null,
});
const ENTRY = (over: Record<string, unknown> = {}) => ({
  id: 'e1', entryNumber: 'JE-2026-00001', entryDate: '2026-11-04T12:00:00.000Z', description: 'Office rent adjustment', sourceType: 'MANUAL', status: 'POSTED', reversalOfId: null,
  totals: { baseDebit: '150.0000', baseCredit: '150.0000' },
  lines: [line('l1', '5100', 'Office expenses', 'debit', '150.0000'), line('l2', '1010', 'Cashbox USD', 'credit', '150.0000')], ...over,
});
const INVOICE_ENTRY = ENTRY({ id: 'e2', entryNumber: 'JE-2026-00002', description: 'Invoice INV-2026-00001', sourceType: 'INVOICE' });
const ACCOUNTS = [
  { id: 'a1', accountCode: '1010', name: 'Cashbox USD', accountType: 'ASSET', isActive: true, parentId: null, currencyCode: 'USD' },
  { id: 'a2', accountCode: '5100', name: 'Office expenses', accountType: 'EXPENSE', isActive: true, parentId: null, currencyCode: null },
  { id: 'a3', accountCode: '9999', name: 'Retired account', accountType: 'EXPENSE', isActive: false, parentId: null, currencyCode: null },
];
const TB = (balanced = true) => ({
  baseCurrency: 'USD', asOf: null, balanced, totals: { debit: '300.0000', credit: balanced ? '300.0000' : '250.0000' },
  lines: [
    { accountCode: '1010', name: 'Cashbox USD', accountType: 'ASSET', isActive: true, debit: '300.0000', credit: '150.0000', balance: '150.0000' },
    { accountCode: '5100', name: 'Office expenses', accountType: 'EXPENSE', isActive: true, debit: '150.0000', credit: '0.0000', balance: '150.0000' },
  ],
});

let permissions: string[];
let entries: ReturnType<typeof ENTRY>[];
let balanced: boolean;
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['accounting.view', 'accounting.post'];
  entries = [ENTRY(), INVOICE_ENTRY];
  balanced = true;
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const [path, qs = ''] = url.replace('/api/v1', '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: new URLSearchParams(qs), body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/accounting/journal-entries' && method === 'GET') return ok(entries, { page: 1, limit: 20, total: entries.length });
    if (path === '/accounting/accounts') return ok(ACCOUNTS);
    if (path === '/accounting/trial-balance') return ok(TB(balanced));
    if (path === '/currencies') return ok([{ code: 'USD', name: 'US dollar', decimalPlaces: 2 }, { code: 'LBP', name: 'Lebanese pound', decimalPlaces: 0 }]);
    if (method === 'POST') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mount = () => render(<App router={createTestRouter('/accounting') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const last = (path: string) => calls.filter((c) => c.path === path).at(-1)!.query;

describe('journal', () => {
  it('lists entries with source, status and total, and expands to the lines', async () => {
    mount();
    const user = userEvent.setup();
    const row = (await screen.findByText('JE-2026-00001')).closest('tr')!;
    expect(within(row).getByText('Manual')).toBeInTheDocument();
    expect(within(row).getByText('Posted')).toBeInTheDocument();
    expect(within(row).getByText('150.00 USD')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show details JE-2026-00001' }));
    expect(await screen.findByText('Office expenses', { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/1010/)).toBeInTheDocument();
  });

  it('sends the filters to the API', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByText('JE-2026-00001');
    await user.selectOptions(screen.getByLabelText('Source'), 'PAYMENT');
    await user.selectOptions(screen.getByLabelText('Status'), 'REVERSED');
    await waitFor(() => { expect(last('/accounting/journal-entries').get('sourceType')).toBe('PAYMENT'); expect(last('/accounting/journal-entries').get('status')).toBe('REVERSED'); });
    await user.type(screen.getByLabelText('Search'), 'rent');
    await waitFor(() => expect(last('/accounting/journal-entries').get('search')).toBe('rent'));
  });

  it('reverses only a posted manual entry, with a reason', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show details JE-2026-00001' }));
    await user.click(await screen.findByRole('button', { name: 'Reverse entry' }));
    const confirm = screen.getAllByRole('button', { name: 'Reverse entry' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for reversing this entry'), 'Wrong account');
    await user.click(confirm);
    await waitFor(() => expect(sent('POST', '/accounting/journal-entries/e1/reverse')).toHaveLength(1));
    expect(sent('POST', '/accounting/journal-entries/e1/reverse')[0].body).toEqual({ reason: 'Wrong account' });
  });

  it('explains that system entries are undone through their own record', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show details JE-2026-00002' }));
    expect(await screen.findByText('This entry was created automatically (Invoice); cancel or reverse that record instead.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse entry' })).not.toBeInTheDocument();
  });

  it('shows the server refusal on reversing', async () => {
    failNext['POST /accounting/journal-entries/e1/reverse'] = fail(409, 'JOURNAL_ENTRY_ALREADY_REVERSED', 'This entry was already reversed');
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show details JE-2026-00001' }));
    await user.click(await screen.findByRole('button', { name: 'Reverse entry' }));
    await user.type(screen.getByLabelText('Reason for reversing this entry'), 'Oops');
    await user.click(screen.getAllByRole('button', { name: 'Reverse entry' }).at(-1)!);
    expect(await screen.findByText('This entry was already reversed')).toBeInTheDocument();
  });

  it('is view-only without accounting.post', async () => {
    permissions = ['accounting.view'];
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show details JE-2026-00001' }));
    await screen.findByText('Office expenses', { exact: false });
    expect(screen.queryByRole('button', { name: 'Reverse entry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New manual entry' })).not.toBeInTheDocument();
  });

  it('is refused without accounting.view', async () => {
    permissions = ['invoices.view'];
    mount();
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('manual entry', () => {
  const open = async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New manual entry' }));
    const form = (await screen.findByRole('heading', { name: 'New manual entry', level: 2 })).closest('form')!;
    await waitFor(() => expect(within(form.querySelector('#je-acc-0') as HTMLElement).getByRole('option', { name: /5100/ })).toBeInTheDocument());
    return { user, form };
  };

  it('needs a description, accounts and one side per line, and offers only active accounts', async () => {
    const { user, form } = await open();
    expect(within(form.querySelector('#je-acc-0') as HTMLElement).queryByRole('option', { name: /Retired/ })).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Post entry' }));
    expect(await within(form).findByText(/Describe the entry/)).toBeInTheDocument();
    expect(within(form).getAllByText('Choose an account')).toHaveLength(2);
    expect(sent('POST', '/accounting/journal-entries')).toHaveLength(0);
  });

  it('shows whether debits equal credits while typing, then posts', async () => {
    const { user, form } = await open();
    await user.type(within(form).getByLabelText('Description'), 'Office rent adjustment');
    await user.selectOptions(form.querySelector('#je-acc-0') as HTMLElement, '5100');
    await user.type(form.querySelector('#je-debit-0') as HTMLElement, '150');
    await user.selectOptions(form.querySelector('#je-acc-1') as HTMLElement, '1010');
    await user.type(form.querySelector('#je-credit-1') as HTMLElement, '100');
    expect(await within(form).findByText('Difference: 50.00 USD')).toBeInTheDocument();
    await user.clear(form.querySelector('#je-credit-1') as HTMLElement);
    await user.type(form.querySelector('#je-credit-1') as HTMLElement, '150');
    expect(await within(form).findByText('Debits equal credits')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Post entry' }));
    await waitFor(() => expect(sent('POST', '/accounting/journal-entries')).toHaveLength(1));
    expect(sent('POST', '/accounting/journal-entries')[0].body).toMatchObject({
      description: 'Office rent adjustment',
      lines: [{ accountCode: '5100', currencyCode: 'USD', debit: '150' }, { accountCode: '1010', currencyCode: 'USD', credit: '150' }],
    });
  });

  it('typing a debit clears the credit on the same line', async () => {
    const { user, form } = await open();
    await user.type(form.querySelector('#je-credit-0') as HTMLElement, '5');
    await user.type(form.querySelector('#je-debit-0') as HTMLElement, '7');
    expect(form.querySelector('#je-credit-0')).toHaveValue('');
  });

  it('shows the server refusal, e.g. an imbalance in base currency', async () => {
    failNext['POST /accounting/journal-entries'] = fail(422, 'JOURNAL_NOT_BALANCED', 'Debits (150.0000) and credits (100.0000) are not equal in USD');
    const { user, form } = await open();
    await user.type(within(form).getByLabelText('Description'), 'Adjustment');
    await user.selectOptions(form.querySelector('#je-acc-0') as HTMLElement, '5100');
    await user.type(form.querySelector('#je-debit-0') as HTMLElement, '150');
    await user.selectOptions(form.querySelector('#je-acc-1') as HTMLElement, '1010');
    await user.type(form.querySelector('#je-credit-1') as HTMLElement, '100');
    await user.click(within(form).getByRole('button', { name: 'Post entry' }));
    expect(await screen.findByText(/are not equal in USD/)).toBeInTheDocument();
  });
});

describe('trial balance', () => {
  it('lists accounts with totals and says it is balanced', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Trial balance' }));
    const row = (await screen.findByText('Cashbox USD')).closest('tr')!;
    expect(within(row).getByText('Asset')).toBeInTheDocument();
    expect(within(row).getByText('300.00 USD')).toBeInTheDocument();
    expect(screen.getByText('Balanced')).toBeInTheDocument();
  });

  it('warns loudly when the ledger is out of balance, and takes an as-of date', async () => {
    balanced = false;
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Trial balance' }));
    expect(await screen.findByText(/out of balance/)).toBeInTheDocument();
    expect(screen.getByText('Not balanced')).toBeInTheDocument();
    await user.type(screen.getByLabelText('As of'), '2026-10-31');
    await waitFor(() => expect(last('/accounting/trial-balance').get('asOf')).toBe('2026-10-31'));
  });
});

describe('Arabic', () => {
  it('shows the page in Arabic', async () => {
    setLocale('ar');
    mount();
    expect(await screen.findByRole('heading', { name: 'المحاسبة' })).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: 'ميزان المراجعة' })).toBeInTheDocument();
    expect(await screen.findByText('يدوي', { selector: 'td' })).toBeInTheDocument();
  });
});
