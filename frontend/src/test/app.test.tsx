import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import i18n, { setLocale } from '@/i18n';
import { App } from '@/app/App';
import { createTestRouter } from '@/app/router';
import { tokens } from '@/lib/api-client';

const ME = (permissions: string[], extra: Record<string, unknown> = {}) => ({
  user: { id: 'u1', email: 'sara@office.test', firstName: 'Sara', lastName: 'Khoury' },
  tenant: { id: 't1', slug: 'beirut', name: 'Beirut Clearance', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
  branch: null, roles: [{ id: 'r1', code: 'X', name: 'X' }], permissions, availableTenants: [{ id: 't1', slug: 'beirut', name: 'Beirut Clearance' }], ...extra,
});
const OVERVIEW = {
  files: { open: 12, onHold: 3, closed: 40, cancelled: 1, highPriority: 2, unassigned: 4, openedThisMonth: 9, closedThisMonth: 7 },
  tasks: { myOpen: 5, myOverdue: 1, officeOverdue: 2 },
  finance: {
    baseCurrency: 'USD', receivables: '12500.5', clientAdvancesHeld: '300', unrecoveredDisbursements: '80', cashAndBankBase: '9000',
    unpaidInvoices: { count: 3, outstandingByCurrency: { USD: '1000', LBP: '89500000' } }, overdueInvoices: { count: 0, outstandingByCurrency: {} },
  },
};

const res = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => res(200, { success: true, data, meta });

let permissions: string[];
let calls: { method: string; url: string }[];
let loginResponse: () => Response;

beforeEach(() => {
  permissions = ['clients.view', 'clearance_files.view', 'tasks.view', 'reports.view', 'invoices.view'];
  calls = [];
  loginResponse = () => ok({ accessToken: 'A', refreshToken: 'R'.repeat(40), tokenType: 'Bearer', expiresIn: 900, tenant: { id: 't1', slug: 'beirut', name: 'Beirut Clearance' } });
  setLocale('en');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url });
    const path = url.replace('/api/v1', '').split('?')[0];
    if (path === '/auth/login') return loginResponse();
    if (path === '/auth/refresh') return ok({ accessToken: 'A2', refreshToken: 'R2'.repeat(20) });
    if (path === '/auth/me') return ok(ME(permissions));
    if (path === '/auth/logout') return res(204, null);
    if (path === '/dashboard/overview') { const { finance, tasks, ...rest } = OVERVIEW; return ok({ ...rest, ...(permissions.includes('tasks.view') && { tasks }), ...(permissions.includes('reports.view') && permissions.includes('invoices.view') && { finance }) }); }
    if (path === '/clients') return ok([{ id: 'c1', clientCode: 'CLT-00001', name: 'شركة النور للتجارة', clientType: 'COMPANY', phone: '+961 1 234567', email: null, isActive: true }], { page: 1, limit: 20, total: 1 });
    if (path === '/clearance-files') return ok([], { page: 1, limit: 20, total: 0 });
    return res(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route', details: [] } });
  }));
});

const mount = (path = '/') => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<App router={createTestRouter(path) as any} client={client} />);
};
const signIn = async () => {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), 'sara@office.test');
  await user.type(screen.getByLabelText('Password'), 'Correct-Horse-9');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  return user;
};

describe('signing in', () => {
  it('sends anonymous visitors to the login page, then back to the page they wanted', async () => {
    mount('/clients');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Clients' })).toBeInTheDocument();
    expect(await screen.findByText('شركة النور للتجارة')).toBeInTheDocument();
  });

  it('shows a clear message for a wrong password and stays on the login page', async () => {
    loginResponse = () => res(401, { success: false, error: { code: 'INVALID_CREDENTIALS', message: 'x', details: [] } });
    mount('/');
    await signIn();
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
    expect(tokens.access).toBeNull();
  });

  it('asks which office when the account belongs to several', async () => {
    let first = true;
    loginResponse = () => {
      if (first) { first = false; return ok({ tenantSelectionRequired: true, tenants: [{ id: 'a', slug: 'beirut', name: 'Beirut Clearance' }, { id: 'b', slug: 'tripoli', name: 'Tripoli Port Services' }] }); }
      return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    };
    mount('/');
    const user = await signIn();
    const select = await screen.findByLabelText('Choose your office');
    await user.selectOptions(select, 'tripoli');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    const loginCalls = calls.filter((c) => c.url.endsWith('/auth/login'));
    expect(loginCalls).toHaveLength(2);
  });

  it('restores the session from the stored refresh token after a reload', async () => {
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/auth/refresh'))).toBe(true);
  });

  it('signs out, clears the stored session and returns to the login page', async () => {
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Sign out/ }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(tokens.refresh).toBeNull();
  });
});

describe('permissions in the interface', () => {
  const links = () => within(screen.getByRole('navigation', { name: 'main' })).getAllByRole('link').map((a) => a.textContent);

  it('shows only the sections the user may use', async () => {
    permissions = ['clients.view'];
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(links()).toEqual(['Dashboard', 'Clients', 'Business parties']); // parties are listed with the same permission as clients
  });

  it('shows the finance block on the dashboard only with finance permissions', async () => {
    permissions = ['clearance_files.view'];
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/');
    await screen.findByText('Open files');
    expect(screen.queryByText('Receivables')).not.toBeInTheDocument();
  });

  it('refuses a screen typed into the address bar without permission', async () => {
    permissions = ['clients.view'];
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/files');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes('/clearance-files'))).toBe(false); // it did not even ask the server
  });

  it('shows a not-found page for unknown addresses', async () => {
    permissions = ['clearance_files.view'];
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/no-such-page');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('shows the numbers, with money per currency and never added across currencies', async () => {
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/');
    expect(await screen.findByText('12')).toBeInTheDocument();
    expect(screen.getByText('12,500.50 USD')).toBeInTheDocument();
    expect(screen.getByText('1,000.00 USD · 89,500,000 LBP')).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('switches the whole document to right-to-left and translates the interface', async () => {
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Dashboard' });
    expect(document.documentElement.dir).toBe('ltr');
    await user.click(screen.getByRole('button', { name: 'Language' }));
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
    expect(document.documentElement.lang).toBe('ar');
    expect(await screen.findByRole('heading', { name: 'لوحة التحكم' })).toBeInTheDocument();
    expect(i18n.language).toBe('ar');
    expect(within(screen.getByRole('navigation', { name: 'main' })).getByText('العملاء')).toBeInTheDocument();
  });

  it('remembers the language across visits and keeps user data (Arabic names) intact in English', async () => {
    setLocale('ar');
    expect(localStorage.getItem('clearport.locale')).toBe('ar');
    setLocale('en');
    tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
    mount('/clients');
    expect(await screen.findByText('شركة النور للتجارة')).toBeInTheDocument();
  });

  it('login page works in Arabic with the right direction', async () => {
    setLocale('ar');
    mount('/login');
    expect(await screen.findByRole('button', { name: 'تسجيل الدخول' })).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
  });
});
