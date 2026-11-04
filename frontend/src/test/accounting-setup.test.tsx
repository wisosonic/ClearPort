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

const ACCOUNTS = [
  { id: 'a0', accountCode: '1000', name: 'Cash and bank', accountType: 'ASSET', isActive: true, parentId: null, currencyCode: null },
  { id: 'a1', accountCode: '1010', name: 'USD cashbox', accountType: 'ASSET', isActive: true, parentId: 'a0', currencyCode: 'USD' },
  { id: 'a2', accountCode: '5100', name: 'Office expenses', accountType: 'EXPENSE', isActive: false, parentId: null, currencyCode: null },
];
const CASH = [
  { id: 'c1', name: 'USD cashbox', accountType: 'CASHBOX', currencyCode: 'USD', isActive: true, ledgerAccountCode: '1010', balance: '1250.5000' },
  { id: 'c2', name: 'Old LBP box', accountType: 'CASHBOX', currencyCode: 'LBP', isActive: false, ledgerAccountCode: '1020', balance: '0.0000' },
];
const RATES = [
  { id: 'r1', fromCurrency: 'LBP', toCurrency: 'USD', rate: '89500.0000000000', convention: 'FOREIGN_PER_BASE', effectiveAt: '2026-11-03T08:00:00.000Z', source: 'Sayrafa' },
  { id: 'r2', fromCurrency: 'EUR', toCurrency: 'USD', rate: '1.0850000000', convention: 'BASE_PER_FOREIGN', effectiveAt: '2026-11-02T08:00:00.000Z', source: null },
];

let permissions: string[];
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['accounting.view', 'accounting.post', 'payments.view'];
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
    if (path === '/accounting/journal-entries') return ok([], { page: 1, limit: 20, total: 0 });
    if (path === '/accounting/accounts' && method === 'GET') return ok(ACCOUNTS);
    if (path === '/cash-accounts' && method === 'GET') return ok(CASH);
    if (path === '/exchange-rates' && method === 'GET') return ok(RATES);
    if (path === '/currencies') return ok([{ code: 'USD', name: 'US dollar', decimalPlaces: 2 }, { code: 'LBP', name: 'Lebanese pound', decimalPlaces: 0 }, { code: 'EUR', name: 'Euro', decimalPlaces: 2 }]);
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async (tabName: string) => {
  render(<App router={createTestRouter('/accounting') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: tabName }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('chart of accounts', () => {
  it('lists accounts with their parent and state', async () => {
    await open('Chart of accounts');
    const row = (await screen.findByText('USD cashbox')).closest('tr')!;
    expect(within(row).getByText('1000')).toBeInTheDocument(); // parent code
    expect(within(row).getByText('Asset')).toBeInTheDocument();
    expect(within(screen.getByText('Office expenses').closest('tr')!).getByText('Inactive')).toBeInTheDocument();
  });

  it('adds an account: a 3-10 digit code and a name are required', async () => {
    const user = await open('Chart of accounts');
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = (await screen.findByRole('heading', { name: 'Add account', level: 2 })).closest('form')!;
    await user.type(within(form).getByLabelText('Code'), '12');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Enter 3 to 10 digits')).toBeInTheDocument();
    expect(within(form).getByText(/Enter a name/)).toBeInTheDocument();
    expect(sent('POST', '/accounting/accounts')).toHaveLength(0);
    await user.clear(within(form).getByLabelText('Code'));
    await user.type(within(form).getByLabelText('Code'), '1030');
    await user.type(within(form).getByLabelText('Name'), 'Petty cash');
    await user.selectOptions(within(form).getByLabelText('Parent'), 'a0');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/accounting/accounts')).toHaveLength(1));
    expect(sent('POST', '/accounting/accounts')[0].body).toEqual({ accountCode: '1030', name: 'Petty cash', accountType: 'ASSET', parentId: 'a0' });
  });

  it('shows the server refusal for a taken code', async () => {
    failNext['POST /accounting/accounts'] = fail(409, 'ACCOUNT_CODE_TAKEN', 'Account 1010 already exists');
    const user = await open('Chart of accounts');
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = (await screen.findByRole('heading', { name: 'Add account', level: 2 })).closest('form')!;
    await user.type(within(form).getByLabelText('Code'), '1010');
    await user.type(within(form).getByLabelText('Name'), 'Dup');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Account 1010 already exists')).toBeInTheDocument();
  });

  it('renames and deactivates; code and type stay fixed', async () => {
    const user = await open('Chart of accounts');
    await user.click(await screen.findByRole('button', { name: 'Edit 1010' }));
    const input = screen.getByLabelText('Name 1010');
    await user.clear(input);
    await user.type(input, 'Main USD cashbox');
    await user.click(within(input.closest('tr')!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/accounting/accounts/a1')).toHaveLength(1));
    expect(sent('PATCH', '/accounting/accounts/a1')[0].body).toEqual({ name: 'Main USD cashbox' });
    await user.click(await screen.findByRole('button', { name: 'Deactivate 1010' }));
    await waitFor(() => expect(sent('PATCH', '/accounting/accounts/a1')).toHaveLength(2));
    expect(sent('PATCH', '/accounting/accounts/a1')[1].body).toEqual({ isActive: false });
    expect(await screen.findByRole('button', { name: 'Reactivate 5100' })).toBeInTheDocument();
  });

  it('is view-only without accounting.post', async () => {
    permissions = ['accounting.view'];
    await open('Chart of accounts');
    await screen.findByText('USD cashbox');
    expect(screen.queryByRole('button', { name: 'Add account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });
});

describe('cash and bank', () => {
  it('shows balances in each account\'s currency, including inactive accounts', async () => {
    await open('Cash and bank');
    const row = (await screen.findByText('USD cashbox')).closest('tr')!;
    expect(within(row).getByText('1,250.50 USD')).toBeInTheDocument();
    expect(within(row).getByText('1010')).toBeInTheDocument();
    expect(within(screen.getByText('Old LBP box').closest('tr')!).getByText('Inactive')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/cash-accounts')!.query.get('includeInactive')).toBe('true');
  });

  it('adds an account in a chosen currency', async () => {
    const user = await open('Cash and bank');
    await user.click(await screen.findByRole('button', { name: 'Add cash or bank account' }));
    const form = (await screen.findByRole('heading', { name: 'Add cash or bank account', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Enter a name/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Name'), 'Byblos bank');
    await user.selectOptions(within(form).getByLabelText('Type'), 'BANK');
    await user.selectOptions(within(form).getByLabelText('Currency'), 'LBP');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/cash-accounts')).toHaveLength(1));
    expect(sent('POST', '/cash-accounts')[0].body).toEqual({ name: 'Byblos bank', accountType: 'BANK', currencyCode: 'LBP' });
  });

  it('renames and reactivates', async () => {
    const user = await open('Cash and bank');
    await user.click(await screen.findByRole('button', { name: 'Reactivate Old LBP box' }));
    await waitFor(() => expect(sent('PATCH', '/cash-accounts/c2')).toHaveLength(1));
    expect(sent('PATCH', '/cash-accounts/c2')[0].body).toEqual({ isActive: true });
  });

  it('is hidden without payments.view', async () => {
    permissions = ['accounting.view'];
    render(<App router={createTestRouter('/accounting') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('tab', { name: 'Journal' });
    expect(screen.queryByRole('tab', { name: 'Cash and bank' })).not.toBeInTheDocument();
  });
});

describe('exchange rates', () => {
  it('shows what each rate means in plain words', async () => {
    await open('Exchange rates');
    expect(await screen.findByText('1 USD = 89500 LBP')).toBeInTheDocument();
    expect(screen.getByText('1 EUR = 1.085 USD')).toBeInTheDocument();
    expect(screen.getByText('Sayrafa')).toBeInTheDocument();
  });

  it('filters by currency', async () => {
    const user = await open('Exchange rates');
    await screen.findByText('1 USD = 89500 LBP');
    const pick = screen.getByLabelText('Currency');
    await waitFor(() => expect(within(pick).getByRole('option', { name: 'EUR' })).toBeInTheDocument());
    expect(within(pick).queryByRole('option', { name: 'USD' })).not.toBeInTheDocument(); // the base currency has no rate
    await user.selectOptions(pick, 'EUR');
    await waitFor(() => expect(calls.filter((c) => c.path === '/exchange-rates').at(-1)!.query.get('currency')).toBe('EUR'));
  });

  it('records a rate: needs a currency and a positive rate; convention is automatic unless chosen', async () => {
    const user = await open('Exchange rates');
    await user.click(await screen.findByRole('button', { name: 'Record exchange rate' }));
    const form = (await screen.findByRole('heading', { name: 'Record exchange rate', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Choose a currency')).toBeInTheDocument();
    expect(within(form).getByText(/Enter a rate above zero/)).toBeInTheDocument();
    expect(sent('POST', '/exchange-rates')).toHaveLength(0);
    await waitFor(() => expect(within(within(form).getByLabelText('Currency')).getByRole('option', { name: 'LBP' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Currency'), 'LBP');
    await user.type(within(form).getByLabelText('Rate'), '90000');
    await user.type(within(form).getByLabelText('Source'), 'Market');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/exchange-rates')).toHaveLength(1));
    expect(sent('POST', '/exchange-rates')[0].body).toEqual({ currency: 'LBP', rate: '90000', source: 'Market' });
  });

  it('shows the server refusal', async () => {
    failNext['POST /exchange-rates'] = fail(409, 'EXCHANGE_RATE_EXISTS', 'A rate for this currency already exists at exactly that time');
    const user = await open('Exchange rates');
    await user.click(await screen.findByRole('button', { name: 'Record exchange rate' }));
    const form = (await screen.findByRole('heading', { name: 'Record exchange rate', level: 2 })).closest('form')!;
    await waitFor(() => expect(within(within(form).getByLabelText('Currency')).getByRole('option', { name: 'EUR' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Currency'), 'EUR');
    await user.type(within(form).getByLabelText('Rate'), '1.09');
    await user.selectOptions(within(form).getByLabelText('Rate is'), 'BASE_PER_FOREIGN');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already exists at exactly that time/)).toBeInTheDocument();
    expect(sent('POST', '/exchange-rates')[0].body.convention).toBe('BASE_PER_FOREIGN');
  });

  it('can be viewed but not changed without accounting.post', async () => {
    permissions = ['accounting.view'];
    await open('Exchange rates');
    await screen.findByText('1 USD = 89500 LBP');
    expect(screen.queryByRole('button', { name: 'Record exchange rate' })).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the new tabs in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/accounting') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    expect(await screen.findByRole('tab', { name: 'دليل الحسابات' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'أسعار الصرف' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'الصندوق والبنوك' })).toBeInTheDocument();
  });
});
