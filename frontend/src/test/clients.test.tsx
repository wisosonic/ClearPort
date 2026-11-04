import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { setLocale } from '@/i18n';
import { App } from '@/app/App';
import { createTestRouter } from '@/app/router';
import { tokens } from '@/lib/api-client';

const res = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => res(200, { success: true, data, meta });
const fail = (status: number, code: string, message: string) => res(status, { success: false, error: { code, message, details: [] } });

const CONTACT = (over: Record<string, unknown> = {}) => ({ id: 'k1', name: 'Rami Haddad', position: 'Accountant', phone: '+961 3 111222', email: 'rami@nour.test', isPrimary: true, ...over });
const CLIENT = (over: Record<string, unknown> = {}) => ({
  id: 'c1', clientCode: 'CLT-00001', clientType: 'COMPANY', name: 'Al Nour Trading', legalName: 'Al Nour Trading SARL', taxNumber: 'TX-123', registrationNumber: null,
  phone: '+961 1 234567', email: 'info@nour.test', address: 'Beirut port area', countryCode: 'LB', paymentTermsDays: 30, creditLimit: '5000.0000', notes: null, isActive: true,
  contacts: [CONTACT(), CONTACT({ id: 'k2', name: 'Lina Saab', position: null, phone: null, email: null, isPrimary: false })], ...over,
});
const BALANCE = {
  clientId: 'c1', creditLimit: '5000.0000',
  balances: [
    { currency: 'USD', invoiced: '1000.0000', received: '700.0000', refunded: '0.0000', allocated: '600.0000', outstanding: '400.0000', unappliedCredit: '100.0000', netBalance: '300.0000' },
    { currency: 'LBP', invoiced: '9000000.0000', received: '0.0000', refunded: '0.0000', allocated: '0.0000', outstanding: '9000000.0000', unappliedCredit: '0.0000', netBalance: '9000000.0000' },
  ],
};
const STATEMENT = {
  openingBalances: {}, closingBalances: { USD: '300.0000' },
  lines: [
    { date: '2026-11-01', type: 'INVOICE', reference: 'INV-2026-00001', description: 'Invoice INV-2026-00001', currency: 'USD', debit: '1000.0000', credit: '0.0000', balance: '1000.0000' },
    { date: '2026-11-03', type: 'PAYMENT', reference: 'PAY-2026-00001', description: 'client payment PAY-2026-00001', currency: 'USD', debit: '0.0000', credit: '700.0000', balance: '300.0000' },
  ],
};

const ALL = ['clients.view', 'clients.manage', 'clearance_files.view', 'invoices.view', 'payments.view'];
let permissions: string[];
let client: Record<string, unknown>;
let calls: { method: string; path: string; query: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...ALL];
  client = CLIENT();
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const [path, query = ''] = url.replace('/api/v1', '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query, body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/clients' && method === 'GET') return ok([{ ...client, contacts: undefined }], { page: 1, limit: 20, total: 1 });
    if (path === '/clients' && method === 'POST') return ok({ ...CLIENT(), id: 'c9' });
    if (path === '/clients/c1' && method === 'GET') return ok(client);
    if (path === '/clients/c9' && method === 'GET') return ok(CLIENT({ id: 'c9', name: 'شركة الأرز' }));
    if (path === '/clients/c1/files') return ok([{ id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status: 'OPEN', priority: 'NORMAL', openedAt: '2026-11-03T10:00:00.000Z', customsReference: null, currentStage: { code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد' } }], { page: 1, limit: 20, total: 1 });
    if (path === '/clients/c1/balance') return ok(BALANCE);
    if (path === '/clients/c1/statement') return ok(STATEMENT);
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x' });
    if (method === 'DELETE') return res(204, null);
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mount = (path: string) => render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const tab = async (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(await screen.findByRole('tab', { name }));

describe('client list', () => {
  it('links to the client and offers New client only to managers', async () => {
    mount('/clients');
    const link = await screen.findByRole('link', { name: 'Al Nour Trading' });
    expect(link).toHaveAttribute('href', '/clients/c1');
    expect(screen.getByRole('link', { name: 'New client' })).toHaveAttribute('href', '/clients/new');
  });

  it('hides New client without clients.manage', async () => {
    permissions = ['clients.view'];
    mount('/clients');
    await screen.findByRole('link', { name: 'Al Nour Trading' });
    expect(screen.queryByRole('link', { name: 'New client' })).not.toBeInTheDocument();
  });
});

describe('creating a client', () => {
  it('needs a name, validates the fields, and sends only what was filled in', async () => {
    mount('/clients/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a name')).toBeInTheDocument();
    expect(sent('POST', '/clients')).toHaveLength(0);

    await user.type(screen.getByLabelText('Name'), 'شركة الأرز');
    await user.type(screen.getByLabelText('Email'), 'bad');
    await user.clear(screen.getByLabelText('Payment terms'));
    await user.type(screen.getByLabelText('Payment terms'), '400');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Enter a whole number of days from 0 to 365')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'a@cedar.test');
    await user.clear(screen.getByLabelText('Payment terms'));
    await user.type(screen.getByLabelText('Payment terms'), '45');
    await user.type(screen.getByLabelText('Country'), 'lb');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/clients')).toHaveLength(1));
    expect(sent('POST', '/clients')[0].body).toEqual({
      clientType: 'COMPANY', name: 'شركة الأرز', legalName: '', taxNumber: '', registrationNumber: '', phone: '', address: '', notes: '', paymentTermsDays: 45,
      email: 'a@cedar.test', countryCode: 'LB',
    });
    expect(await screen.findByRole('heading', { name: 'شركة الأرز', level: 1 })).toBeInTheDocument(); // opens the new client
  });

  it('shows the server message, e.g. a taken code', async () => {
    failNext['POST /clients'] = fail(409, 'CLIENT_CODE_TAKEN', 'Client code CLT-1 is already used in your office');
    mount('/clients/new');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Name'), 'X');
    await user.type(screen.getByLabelText('Code'), 'clt-1');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/already used in your office/)).toBeInTheDocument();
    expect(sent('POST', '/clients')[0].body.clientCode).toBe('clt-1');
  });

  it('is not reachable without clients.manage', async () => {
    permissions = ['clients.view'];
    mount('/clients/new');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('client page', () => {
  it('shows the details', async () => {
    mount('/clients/c1');
    expect(await screen.findByRole('heading', { name: 'Al Nour Trading', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('CLT-00001')).toBeInTheDocument();
    expect(screen.getByText('Al Nour Trading SARL')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText('5,000.00')).toBeInTheDocument();
  });

  it('edits the details: the code is fixed, empty optional fields are cleared', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Code')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email'));
    await user.clear(screen.getByLabelText('Credit limit'));
    await user.clear(screen.getByLabelText('Payment terms'));
    await user.type(screen.getByLabelText('Payment terms'), '60');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/clients/c1')).toHaveLength(1));
    expect(sent('PATCH', '/clients/c1')[0].body).toMatchObject({ name: 'Al Nour Trading', email: null, creditLimit: null, paymentTermsDays: 60, countryCode: 'LB' });
  });

  it('deactivates and reactivates', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await user.click(await screen.findByRole('button', { name: 'Deactivate' }));
    await waitFor(() => expect(sent('PATCH', '/clients/c1')).toHaveLength(1));
    expect(sent('PATCH', '/clients/c1')[0].body).toEqual({ isActive: false });
  });

  it('is view-only without clients.manage', async () => {
    permissions = ['clients.view'];
    mount('/clients/c1');
    await screen.findByRole('heading', { name: 'Al Nour Trading', level: 1 });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Files' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Account' })).not.toBeInTheDocument();
  });

  it('says so when the client does not exist', async () => {
    mount('/clients/zzz');
    expect(await screen.findByText('This client was not found.')).toBeInTheDocument();
  });
});

describe('contacts', () => {
  it('lists contacts with the primary marked', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Contacts');
    const row = (await screen.findByText('Rami Haddad')).closest('li')!;
    expect(within(row).getByText('Primary')).toBeInTheDocument();
    expect(within(row).getByText('Accountant')).toBeInTheDocument();
    expect(screen.getByText('Lina Saab').closest('li')).not.toHaveTextContent('Primary');
  });

  it('adds a contact, asking for a name and a valid email', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Contacts');
    await user.click(await screen.findByRole('button', { name: 'Add contact' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a name')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Name'), 'Nour Khalil');
    await user.type(screen.getByLabelText('Email'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Email'));
    await user.click(screen.getByLabelText('Primary contact'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/clients/c1/contacts')).toHaveLength(1));
    expect(sent('POST', '/clients/c1/contacts')[0].body).toEqual({ name: 'Nour Khalil', position: '', phone: '', isPrimary: true });
  });

  it('edits a contact and can make it the primary one', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Contacts');
    await user.click(await screen.findByRole('button', { name: 'Edit Lina Saab' }));
    await user.type(screen.getByLabelText('Phone'), '+961 70 000000');
    await user.click(screen.getByLabelText('Primary contact'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/clients/c1/contacts/k2')).toHaveLength(1));
    expect(sent('PATCH', '/clients/c1/contacts/k2')[0].body).toEqual({ name: 'Lina Saab', position: '', phone: '+961 70 000000', email: null, isPrimary: true });
  });

  it('removes a contact only after confirming', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Contacts');
    await user.click(await screen.findByRole('button', { name: 'Remove Lina Saab' }));
    expect(sent('DELETE', '/clients/c1/contacts/k2')).toHaveLength(0);
    await user.click(within(screen.getByText('Remove Lina Saab from this client?').parentElement!).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent('DELETE', '/clients/c1/contacts/k2')).toHaveLength(1));
  });

  it('cannot be changed without clients.manage', async () => {
    permissions = ['clients.view'];
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Contacts');
    await screen.findByText('Rami Haddad');
    expect(screen.queryByRole('button', { name: 'Add contact' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
  });
});

describe('files and account', () => {
  it('lists the client files with a link to each', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Files');
    expect(await screen.findByRole('link', { name: 'IMP-2026-00001' })).toHaveAttribute('href', '/files/f1');
    expect(screen.getByText('New file')).toBeInTheDocument();
  });

  it('shows the balance per currency and the statement, filtered by currency', async () => {
    const user = userEvent.setup();
    mount('/clients/c1');
    await tab(user, 'Account');
    const usd = (await screen.findByRole('cell', { name: 'USD' })).closest('tr')!;
    expect(within(usd).getByText('1,000.00 USD')).toBeInTheDocument();
    expect(within(usd).getByText('300.00 USD')).toBeInTheDocument();
    const lbp = screen.getByRole('cell', { name: 'LBP' }).closest('tr')!;
    expect(within(lbp).getAllByText('9,000,000 LBP').length).toBeGreaterThan(0);
    expect(await screen.findByText('INV-2026-00001')).toBeInTheDocument();
    expect(screen.getByText(/Closing balance/)).toHaveTextContent('300.00 USD');

    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    await waitFor(() => expect(calls.some((c) => c.path === '/clients/c1/statement' && c.query.includes('currency=USD'))).toBe(true));
  });
});

describe('Arabic', () => {
  it('shows the client page in Arabic', async () => {
    setLocale('ar');
    const user = userEvent.setup();
    mount('/clients/c1');
    expect(await screen.findByRole('tab', { name: 'جهات الاتصال' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'جهات الاتصال' }));
    expect(await screen.findByText('Rami Haddad')).toBeInTheDocument();
  });
});
