import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { setLocale } from '@/i18n';
import { App } from '@/app/App';
import { createTestRouter } from '@/app/router';
import { changedFields, humanize } from '@/features/audit/AuditPage';
import { tokens } from '@/lib/api-client';

const res = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => res(200, { success: true, data, meta });

const ENTRIES = [
  {
    id: 'a1', action: 'INVOICE_ISSUED', entityType: 'Invoice', entityId: '0b1c2d3e-aaaa-bbbb-cccc-111122223333', actor: { id: 'u1', name: 'Sara Khoury', email: 'sara@demo.test' },
    before: { status: 'DRAFT', total: '100.0000', tenantId: 't' }, after: { status: 'ISSUED', total: '100.0000', invoiceNumber: 'INV-2026-00001', tenantId: 't' },
    ipAddress: '10.0.0.5', userAgent: 'Mozilla/5.0 Test', createdAt: '2026-11-04T09:30:00.000Z',
  },
  { id: 'a2', action: 'AUTH_LOGIN_FAILED', entityType: 'User', entityId: null, actor: null, before: null, after: null, ipAddress: '1.2.3.4', userAgent: null, createdAt: '2026-11-04T08:00:00.000Z' },
];
const USERS = [{ id: 'u1', firstName: 'Sara', lastName: 'Khoury' }, { id: 'u2', firstName: 'Rami', lastName: 'Haddad' }];

let permissions: string[];
let calls: { path: string; query: URLSearchParams }[];

beforeEach(() => {
  permissions = ['audit.view', 'users.manage'];
  calls = [];
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const [path, qs = ''] = url.replace('/api/v1', '').split('?');
    calls.push({ path, query: new URLSearchParams(qs) });
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/audit-logs') return ok(ENTRIES, { page: 1, limit: 50, total: 2 });
    if (path === '/users') return ok(USERS, { page: 1, limit: 100, total: 2 });
    return res(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route', details: [] } });
  }));
});

const mount = () => render(<App router={createTestRouter('/audit') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const last = () => calls.filter((c) => c.path === '/audit-logs').at(-1)!.query;

describe('helpers', () => {
  it('turns codes into readable words', () => {
    expect(humanize('INVOICE_ISSUED')).toBe('Invoice issued');
    expect(humanize('ClearanceFile')).toBe('Clearance file');
    expect(humanize('AUTH_LOGIN')).toBe('Auth login');
  });

  it('lists only the fields that changed, without plumbing fields', () => {
    expect(changedFields({ a: 1, b: 2, tenantId: 'x' }, { a: 1, b: 3, c: 4, tenantId: 'y' }).map((r) => [r.key, r.before, r.after])).toEqual([['b', 2, 3], ['c', undefined, 4]]);
    expect(changedFields(null, { name: 'New', tenantId: 't' }).map((r) => r.key)).toEqual(['name']); // a created record lists everything
    expect(changedFields('x', 'y')).toEqual([]);
  });
});

describe('audit page', () => {
  it('lists entries with who, what and which record; system entries have no person', async () => {
    mount();
    const row = (await screen.findByText('Invoice issued', { selector: 'td' })).closest('tr')!;
    expect(within(row).getByText('Sara Khoury')).toBeInTheDocument();
    expect(within(row).getByText('Invoice')).toBeInTheDocument();
    expect(within(row).getByText('0b1c2d3e')).toBeInTheDocument(); // short id
    const failed = screen.getByText('Auth login failed', { selector: 'td' }).closest('tr')!;
    expect(within(failed).getByText('System')).toBeInTheDocument();
  });

  it('shows what changed, the IP and the device when an entry is opened', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show details Invoice issued' }));
    const status = (await screen.findByText('status')).closest('tr')!;
    expect(within(status).getByText('DRAFT')).toBeInTheDocument();
    expect(within(status).getByText('ISSUED')).toBeInTheDocument();
    expect(screen.getByText('invoiceNumber')).toBeInTheDocument(); // added field
    expect(screen.queryByText('total')).not.toBeInTheDocument(); // unchanged
    expect(screen.queryByText('tenantId')).not.toBeInTheDocument();
    expect(screen.getByText('10.0.0.5')).toBeInTheDocument();
    expect(screen.getByText('Mozilla/5.0 Test')).toBeInTheDocument();
  });

  it('says so when no details were recorded', async () => {
    mount();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show details Auth login failed' }));
    expect(await screen.findByText('No details were recorded for this entry.')).toBeInTheDocument();
  });

  it('sends the filters; dates cover the whole local day', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByText('Invoice issued', { selector: 'td' });
    await user.type(screen.getByLabelText('Action'), 'INVOICE_ISSUED');
    await user.selectOptions(screen.getByLabelText('Record'), 'Invoice');
    await waitFor(() => expect(within(screen.getByLabelText('Who')).getByRole('option', { name: 'Rami Haddad' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Who'), 'u2');
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.type(screen.getByLabelText('To'), '2026-11-04');
    await waitFor(() => {
      const q = last();
      expect(q.get('action')).toBe('INVOICE_ISSUED'); expect(q.get('entityType')).toBe('Invoice'); expect(q.get('actorUserId')).toBe('u2');
      expect(new Date(q.get('from')!).getTime()).toBe(new Date(2026, 10, 1, 0, 0, 0).getTime());
      expect(new Date(q.get('to')!).getTime()).toBe(new Date(2026, 10, 4, 23, 59, 59, 999).getTime());
    });
  });

  it('cannot filter by person without users.manage, but still works', async () => {
    permissions = ['audit.view'];
    mount();
    await screen.findByText('Invoice issued', { selector: 'td' });
    expect(screen.queryByLabelText('Who')).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/users')).toBe(false);
  });

  it('is in the menu and refused without audit.view', async () => {
    permissions = ['users.manage'];
    mount();
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Audit log' })).not.toBeInTheDocument();
  });

  it('shows the menu link with audit.view', async () => {
    mount();
    expect(await screen.findByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/audit');
  });

  it('works in Arabic', async () => {
    setLocale('ar');
    mount();
    expect(await screen.findByRole('heading', { name: 'سجل التدقيق', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('النظام')).toBeInTheDocument();
  });
});
