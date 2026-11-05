import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/i18n';
import { setLocale } from '@/i18n';
import { App } from '@/app/App';
import { createTestRouter } from '@/app/router';
import { setFontSize, setTheme } from '@/lib/appearance';
import { tokens } from '@/lib/api-client';

const res = (status: number, body: unknown) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ok = (data: unknown, meta?: unknown) => res(200, { success: true, data, meta });
const fail = (status: number, code: string, message: string) => res(status, { success: false, error: { code, message, details: [] } });

const CURRENCIES = [{ code: 'USD', name: 'US dollar', decimalPlaces: 2, isActive: true }, { code: 'LBP', name: 'Lebanese pound', decimalPlaces: 0, isActive: true }, { code: 'EUR', name: 'Euro', decimalPlaces: 2, isActive: true }];
const OFFICE = { id: 't', name: 'Demo Office', slug: 'demo', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en', status: 'ACTIVE', notifyInApp: true, notifyEmail: false, notifySms: false, allowSelfApproval: true };
const NOTICES = [
  { id: 'n1', type: 'FILE_ASSIGNED', title: 'File IMP-2026-00001 assigned to you', readAt: null, createdAt: '2026-11-04T10:00:00.000Z', metadata: { clearanceFileId: 'f1' } },
  { id: 'n2', type: 'TASK_OVERDUE', title: 'Task overdue: Send BL', readAt: '2026-11-04T11:00:00.000Z', createdAt: '2026-11-03T10:00:00.000Z', metadata: { taskId: 't1' } },
];

let permissions: string[];
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;
let canChange: { canChange: boolean; blockers: string[] };
let latest: Response | null;

beforeEach(() => {
  permissions = ['settings.manage', 'accounting.post', 'clearance_files.view', 'tasks.view'];
  calls = [];
  failNext = {};
  canChange = { canChange: false, blockers: ['INVOICES', 'EXCHANGE_RATES'] };
  latest = null;
  setLocale('en');
  setTheme('light');
  setFontSize('medium');
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
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: OFFICE.defaultCurrency, timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/tenant' && method === 'GET') return ok(OFFICE);
    if (path === '/tenant/currency-change') return ok(canChange);
    if (path === '/currencies') return ok(CURRENCIES);
    if (path === '/exchange-rates/latest') return latest ?? ok({ rate: '89500.0000000000', convention: 'FOREIGN_PER_BASE', source: 'Sayrafa', currency: 'LBP', baseCurrency: 'USD' });
    if (path === '/notifications' && method === 'GET') return ok(NOTICES, { page: 1, limit: 15, total: 2, unreadCount: 1 });
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async (tab = 'General') => {
  render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  if (tab) await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('appearance', () => {
  it('switches the whole app to dark and back, remembering the choice', async () => {
    const user = await open();
    const theme = await screen.findByRole('radiogroup', { name: 'Theme' });
    expect(within(theme).getByRole('radio', { name: 'Light' })).toBeChecked();
    expect(document.documentElement).not.toHaveClass('dark');
    await user.click(within(theme).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(localStorage.getItem('clearport.theme')).toBe('dark');
    await user.click(within(theme).getByRole('radio', { name: 'Light' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('changes the text size for the whole app', async () => {
    const user = await open();
    const size = await screen.findByRole('radiogroup', { name: 'Text size' });
    expect(within(size).getByRole('radio', { name: 'Medium' })).toBeChecked();
    await user.click(within(size).getByRole('radio', { name: 'Large' }));
    expect(document.documentElement.dataset.fontSize).toBe('large');
    expect(localStorage.getItem('clearport.fontSize')).toBe('large');
    await user.click(within(size).getByRole('radio', { name: 'Small' }));
    expect(document.documentElement.dataset.fontSize).toBe('small');
  });

  it('can be toggled from the header too, and the two stay in step', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Switch to dark mode' }));
    expect(document.documentElement).toHaveClass('dark');
    expect(within(screen.getByRole('radiogroup', { name: 'Theme' })).getByRole('radio', { name: 'Dark' })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });

  it('is available to someone who may only configure workflows', async () => {
    permissions = ['workflows.manage', 'clearance_files.view'];
    await open();
    expect(await screen.findByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeEnabled();
  });
});

describe('currency', () => {
  it('shows the main currency, fixed once records exist, and says what is in the way', async () => {
    await open();
    const main = await screen.findByLabelText('Main currency');
    expect(main).toHaveValue('USD');
    expect(main).toBeDisabled();
    expect(await screen.findByText(/The main currency is fixed because the office already has: invoices, exchange rates/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('lets a brand-new office pick its main currency', async () => {
    canChange = { canChange: true, blockers: [] };
    const user = await open();
    const main = await screen.findByLabelText('Main currency');
    await waitFor(() => expect(main).toBeEnabled());
    await user.selectOptions(main, 'EUR');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/tenant')).toHaveLength(1));
    expect(sent('PATCH', '/tenant')[0].body).toEqual({ defaultCurrency: 'EUR' });
  });

  it('shows the server refusal for a change it does not allow', async () => {
    canChange = { canChange: true, blockers: [] };
    failNext['PATCH /tenant'] = fail(422, 'BASE_CURRENCY_IN_USE', 'The main currency cannot be changed once invoices exist');
    const user = await open();
    const main = await screen.findByLabelText('Main currency');
    await waitFor(() => expect(main).toBeEnabled());
    await user.selectOptions(main, 'LBP');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/cannot be changed once invoices exist/)).toBeInTheDocument();
  });

  it('shows the current USD to LBP rate and records a new one as "1 USD = rate LBP"', async () => {
    const user = await open();
    expect(await screen.findByText('Exchange rate: USD to LBP')).toBeInTheDocument();
    expect(await screen.findByText('Current rate: 1 USD = 89,500 LBP')).toBeInTheDocument();
    expect(sent('GET', '/exchange-rates/latest')[0].query.get('currency')).toBe('LBP');
    await user.click(screen.getByRole('button', { name: 'Record rate' }));
    expect(await screen.findByText(/Enter a rate above zero/)).toBeInTheDocument();
    expect(sent('POST', '/exchange-rates')).toHaveLength(0);
    await user.type(screen.getByLabelText('New rate'), '90000');
    await user.click(screen.getByRole('button', { name: 'Record rate' }));
    await waitFor(() => expect(sent('POST', '/exchange-rates')).toHaveLength(1));
    expect(sent('POST', '/exchange-rates')[0].body).toEqual({ currency: 'LBP', rate: '90000', convention: 'FOREIGN_PER_BASE', source: 'Settings' });
    expect(await screen.findByText(/Rate recorded/)).toBeInTheDocument();
  });

  it('says so when no rate is on file, and can record one for another currency', async () => {
    latest = fail(422, 'EXCHANGE_RATE_REQUIRED', 'No rate');
    const user = await open();
    expect(await screen.findByText('No LBP rate is on file yet.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Currency', { selector: 'select[aria-label]' }), 'EUR');
    await user.type(screen.getByLabelText('New rate'), '0.92');
    await user.click(screen.getByRole('button', { name: 'Record rate' }));
    await waitFor(() => expect(sent('POST', '/exchange-rates')).toHaveLength(1));
    expect(sent('POST', '/exchange-rates')[0].body).toMatchObject({ currency: 'EUR', rate: '0.92', convention: 'FOREIGN_PER_BASE' });
  });

  it('is read-only without the permissions', async () => {
    permissions = ['workflows.manage', 'clearance_files.view'];
    await open();
    expect(await screen.findByLabelText('Main currency')).toBeDisabled();
    expect(await screen.findByText('Current rate: 1 USD = 89,500 LBP')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record rate' })).not.toBeInTheDocument();
    expect(screen.getByText(/needs the accounting permission/)).toBeInTheDocument();
    expect(sent('GET', '/tenant/currency-change')).toHaveLength(0); // it would be refused
  });
});

describe('notifications', () => {
  it('shows the three channels as switches, with email and SMS honest about not being connected', async () => {
    await open();
    const inApp = await screen.findByRole('switch', { name: 'In-app notifications' });
    expect(inApp).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Email' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'SMS' })).not.toBeChecked();
    expect(screen.getAllByText(/No (email|SMS) service is connected yet/)).toHaveLength(2);
  });

  it('saves a switch as soon as it is flipped', async () => {
    const user = await open();
    await user.click(await screen.findByRole('switch', { name: 'Email' }));
    await waitFor(() => expect(sent('PATCH', '/tenant')).toHaveLength(1));
    expect(sent('PATCH', '/tenant')[0].body).toEqual({ notifyEmail: true });
    await user.click(screen.getByRole('switch', { name: 'In-app notifications' }));
    await waitFor(() => expect(sent('PATCH', '/tenant')).toHaveLength(2));
    expect(sent('PATCH', '/tenant')[1].body).toEqual({ notifyInApp: false });
  });

  it('shows the server refusal', async () => {
    failNext['PATCH /tenant'] = fail(403, 'PERMISSION_DENIED', 'You do not have permission to do that');
    const user = await open();
    await user.click(await screen.findByRole('switch', { name: 'SMS' }));
    expect(await screen.findByText('You do not have permission to do that')).toBeInTheDocument();
  });

  it('cannot be changed without settings.manage', async () => {
    permissions = ['workflows.manage', 'clearance_files.view'];
    await open();
    expect(await screen.findByRole('switch', { name: 'Email' })).toBeDisabled();
    expect(screen.getByText(/Only someone who manages office settings/)).toBeInTheDocument();
  });
});

describe('the notification bell', () => {
  it('shows the unread count, lists notifications, and opens the file when one is clicked', async () => {
    const user = await open(null as unknown as string);
    const bell = await screen.findByRole('button', { name: 'Notifications (1 unread)' });
    await user.click(bell);
    const panel = await screen.findByRole('region', { name: 'Notifications' });
    expect(within(panel).getByText('File IMP-2026-00001 assigned to you')).toBeInTheDocument();
    expect(within(panel).getByText('Task overdue: Send BL')).toBeInTheDocument();
    await user.click(within(panel).getByText('File IMP-2026-00001 assigned to you'));
    await waitFor(() => expect(sent('POST', '/notifications/n1/read')).toHaveLength(1));
    expect(screen.queryByRole('region', { name: 'Notifications' })).not.toBeInTheDocument(); // closed after navigating
  });

  it('marks all as read, and does not re-mark one already read', async () => {
    const user = await open(null as unknown as string);
    await user.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    const panel = await screen.findByRole('region', { name: 'Notifications' });
    await user.click(within(panel).getByText('Task overdue: Send BL'));
    expect(sent('POST', '/notifications/n2/read')).toHaveLength(0);
    await user.click(await screen.findByRole('button', { name: 'Notifications (1 unread)' }));
    await user.click(within(await screen.findByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(sent('POST', '/notifications/read-all')).toHaveLength(1));
  });
});

describe('Arabic', () => {
  it('shows the General tab in Arabic', async () => {
    setLocale('ar');
    await open('عام');
    expect(await screen.findByRole('radiogroup', { name: 'السمة' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'إشعارات داخل التطبيق' })).toBeInTheDocument();
    expect(screen.getByText('العملة الرئيسية')).toBeInTheDocument();
  });
});
