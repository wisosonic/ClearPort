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

const OFFICE = { id: 't', name: 'Demo Office', slug: 'demo', legalName: 'Demo Office SARL', email: 'info@demo.test', phone: '+961 1 000000', address: 'Beirut', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en', status: 'ACTIVE' };
const BRANCHES = [
  { id: 'b1', code: 'BEY', name: 'Beirut', address: 'Port of Beirut', phone: null, isActive: true },
  { id: 'b2', code: 'TRI', name: 'Tripoli', address: null, phone: '+961 6 000000', isActive: false },
];
const CATS = [
  { id: 'c1', name: 'Clearance service fees', categoryType: 'SERVICE_FEE', costTreatment: 'OFFICE_REVENUE', isBillableToClient: true, isTaxable: true, isActive: true },
  { id: 'c2', name: 'Port fees', categoryType: 'PORT_FEE', costTreatment: 'PASS_THROUGH', isBillableToClient: true, isTaxable: false, isActive: true },
  { id: 'c3', name: 'Old category', categoryType: 'OTHER', costTreatment: 'OFFICE_EXPENSE', isBillableToClient: false, isTaxable: false, isActive: false },
];

let permissions: string[];
let tax: { enabled: boolean; name: string; ratePercent: string };
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['settings.manage'];
  tax = { enabled: false, name: 'VAT', ratePercent: '0.0000' };
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
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'demo', name: 'Demo Office', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/tenant' && method === 'GET') return ok(OFFICE);
    if (path === '/branches' && method === 'GET') return ok(BRANCHES);
    if (path === '/settings/tax' && method === 'GET') return ok(tax);
    if (path === '/financial-categories' && method === 'GET') return ok(CATS);
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async (tab?: string) => {
  render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  if (tab) await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('office', () => {
  it('shows the office, with the base currency fixed', async () => {
    await open();
    expect(await screen.findByLabelText('Office name')).toHaveValue('Demo Office');
    expect(screen.getByLabelText('Email')).toHaveValue('info@demo.test');
    expect(screen.getByText('Base currency')).toBeInTheDocument();
    expect(screen.getByText(/changing it would reinterpret/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Base currency')).not.toBeInTheDocument();
  });

  it('validates, then saves and reloads the signed-in office', async () => {
    const user = await open();
    const name = await screen.findByLabelText('Office name');
    await user.clear(name);
    await user.type(name, 'D');
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter a name \(2 characters/)).toBeInTheDocument();
    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(sent('PATCH', '/tenant')).toHaveLength(0);

    await user.clear(name);
    await user.type(name, 'Demo Customs');
    await user.clear(screen.getByLabelText('Email'));
    await user.clear(screen.getByLabelText('Phone'));
    const meCalls = sent('GET', '/auth/me').length;
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/tenant')).toHaveLength(1));
    expect(sent('PATCH', '/tenant')[0].body).toEqual({
      name: 'Demo Customs', legalName: 'Demo Office SARL', email: null, phone: null, address: 'Beirut', timezone: 'Asia/Beirut', locale: 'en', allowSelfApproval: true,
    });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => expect(sent('GET', '/auth/me').length).toBeGreaterThan(meCalls));
  });

  it('can require that someone else approves expenses', async () => {
    const user = await open();
    await user.click(await screen.findByLabelText(/Someone else must approve an expense/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/tenant')).toHaveLength(1));
    expect(sent('PATCH', '/tenant')[0].body).toMatchObject({ allowSelfApproval: false });
  });

  it('shows the server message when saving is refused', async () => {
    failNext['PATCH /tenant'] = fail(403, 'PERMISSION_DENIED', 'You do not have permission to do that');
    const user = await open();
    await screen.findByLabelText('Office name');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('You do not have permission to do that')).toBeInTheDocument();
  });

  it('is refused without settings.manage', async () => {
    permissions = ['clients.view'];
    await open();
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('branches', () => {
  it('lists branches including inactive ones', async () => {
    await open('Branches');
    const row = (await screen.findByText('Beirut')).closest('tr')!;
    expect(within(row).getByText('Port of Beirut')).toBeInTheDocument();
    expect(within(screen.getByText('Tripoli').closest('tr')!).getByText('Inactive')).toBeInTheDocument();
  });

  it('adds a branch: needs a valid code and a name', async () => {
    const user = await open('Branches');
    await user.click(await screen.findByRole('button', { name: 'Add branch' }));
    const form = (await screen.findByRole('heading', { name: 'Add branch', level: 2 })).closest('form')!;
    await user.type(within(form).getByLabelText('Code'), 'a b');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Use letters, digits, - and _ only/)).toBeInTheDocument();
    expect(sent('POST', '/branches')).toHaveLength(0);
    await user.clear(within(form).getByLabelText('Code'));
    await user.type(within(form).getByLabelText('Code'), 'SID');
    await user.type(within(form).getByLabelText('Name'), 'Sidon');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/branches')).toHaveLength(1));
    expect(sent('POST', '/branches')[0].body).toEqual({ code: 'SID', name: 'Sidon' });
  });

  it('edits (code fixed, empty fields cleared) and deactivates', async () => {
    const user = await open('Branches');
    await user.click(await screen.findByRole('button', { name: 'Edit Beirut' }));
    const form = (await screen.findByRole('heading', { name: 'Edit branch', level: 2 })).closest('form')!;
    expect(within(form).queryByLabelText('Code')).not.toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Address'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/branches/b1')).toHaveLength(1));
    expect(sent('PATCH', '/branches/b1')[0].body).toEqual({ name: 'Beirut', address: null, phone: null });
    await user.click(await screen.findByRole('button', { name: 'Deactivate Beirut' }));
    await waitFor(() => expect(sent('PATCH', '/branches/b1')).toHaveLength(2));
    expect(sent('PATCH', '/branches/b1')[1].body).toEqual({ isActive: false });
  });
});

describe('tax', () => {
  it('starts switched off and saves the rate the office types', async () => {
    const user = await open('Tax');
    const on = await screen.findByLabelText('Charge tax on invoices');
    expect(on).not.toBeChecked();
    await user.click(on);
    await user.clear(screen.getByLabelText('Rate (%)'));
    await user.type(screen.getByLabelText('Rate (%)'), '150');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Enter a rate from 0 to 100/)).toBeInTheDocument();
    expect(sent('PUT', '/settings/tax')).toHaveLength(0);
    await user.clear(screen.getByLabelText('Rate (%)'));
    await user.type(screen.getByLabelText('Rate (%)'), '11');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PUT', '/settings/tax')).toHaveLength(1));
    expect(sent('PUT', '/settings/tax')[0].body).toEqual({ enabled: true, name: 'VAT', ratePercent: '11' });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('warns when tax is on with a zero rate, and says changes affect new invoices only', async () => {
    tax = { enabled: true, name: 'VAT', ratePercent: '0.0000' };
    await open('Tax');
    expect(await screen.findByText(/rate is 0, so no tax will be charged/)).toBeInTheDocument();
    expect(screen.getByText(/new invoices only/)).toBeInTheDocument();
    expect(screen.getByLabelText('Rate (%)')).toHaveValue('0');
  });

  it('shows a saved rate without trailing zeros', async () => {
    tax = { enabled: true, name: 'TVA', ratePercent: '11.5000' };
    await open('Tax');
    expect(await screen.findByLabelText('Rate (%)')).toHaveValue('11.5');
    expect(screen.getByLabelText('Tax name')).toHaveValue('TVA');
  });
});

describe('financial categories', () => {
  it('lists categories with their treatment, including inactive ones', async () => {
    await open('Financial categories');
    const row = (await screen.findByText('Port fees')).closest('tr')!;
    expect(within(row).getByText('Paid for the client, re-billed at cost')).toBeInTheDocument();
    expect(within(row).getByText('Port fee')).toBeInTheDocument();
    expect(within(screen.getByText('Old category').closest('tr')!).getByText('Inactive')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/financial-categories')!.query.get('includeInactive')).toBe('true');
  });

  it('adds a category with its kind and treatment', async () => {
    const user = await open('Financial categories');
    await user.click(await screen.findByRole('button', { name: 'Add category' }));
    const form = (await screen.findByRole('heading', { name: 'Add category', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Enter a name/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Name'), 'Agency fees');
    await user.selectOptions(within(form).getByLabelText('Kind'), 'SHIPPING_FEE');
    await user.selectOptions(within(form).getByLabelText('Treatment'), 'PASS_THROUGH');
    expect(within(form).getByText(/recorded as an expense, then billed on an invoice at cost/)).toBeInTheDocument();
    await user.click(within(form).getByLabelText('Taxable'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/financial-categories')).toHaveLength(1));
    expect(sent('POST', '/financial-categories')[0].body).toEqual({ name: 'Agency fees', categoryType: 'SHIPPING_FEE', costTreatment: 'PASS_THROUGH', isBillableToClient: true, isTaxable: true });
  });

  it('edits name and flags only; kind and treatment are fixed', async () => {
    const user = await open('Financial categories');
    await user.click(await screen.findByRole('button', { name: 'Edit Port fees' }));
    const form = (await screen.findByRole('heading', { name: 'Edit category', level: 2 })).closest('form')!;
    expect(within(form).getByLabelText('Kind')).toBeDisabled();
    expect(within(form).getByLabelText('Treatment')).toBeDisabled();
    await user.click(within(form).getByLabelText('Taxable'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/financial-categories/c2')).toHaveLength(1));
    expect(sent('PATCH', '/financial-categories/c2')[0].body).toEqual({ name: 'Port fees', isBillableToClient: true, isTaxable: true });
  });

  it('deactivates and reactivates, showing a server refusal', async () => {
    failNext['PATCH /financial-categories/c3'] = fail(409, 'CATEGORY_NAME_TAKEN', 'A category with this name already exists');
    const user = await open('Financial categories');
    await user.click(await screen.findByRole('button', { name: 'Deactivate Port fees' }));
    await waitFor(() => expect(sent('PATCH', '/financial-categories/c2')).toHaveLength(1));
    expect(sent('PATCH', '/financial-categories/c2')[0].body).toEqual({ isActive: false });
    await user.click(screen.getByRole('button', { name: 'Reactivate Old category' }));
    expect(await screen.findByText('A category with this name already exists')).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the page in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    expect(await screen.findByRole('heading', { name: 'الإعدادات' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'الفئات المالية' })).toBeInTheDocument();
    expect(await screen.findByLabelText('اسم المكتب')).toHaveValue('Demo Office');
  });
});
