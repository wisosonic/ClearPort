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
const pdf = (name: string) => new Response(new Blob(['%PDF-1.4']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"` } });

const FILE = { id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status: 'OPEN', priority: 'NORMAL', openedAt: '2026-11-03T10:00:00.000Z', expectedArrivalAt: null, closedAt: null, customsReference: null, internalNotes: null, client: { id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading' }, branch: null, currentStage: { id: 's1', code: 'NEW_FILE', nameEn: 'New file', nameAr: null, isTerminal: false }, assignee: null, createdBy: null, workflowTemplate: null, shipments: [] };
const INV = (status: string) => ({ id: 'i1', invoiceNumber: status === 'DRAFT' ? 'DRAFT-AB12' : 'INV-2026-00001', invoiceType: 'STANDARD', status, currencyCode: 'USD', issueDate: null, dueDate: null, cancelReason: null, subtotal: '100.0000', discount: '0.0000', taxAmount: '0.0000', totalAmount: '100.0000', paidAmount: '0.0000', outstandingAmount: '100.0000', paymentStatus: status === 'ISSUED' ? 'UNPAID' : null, isOverdue: false, items: [] });

let permissions: string[];
let invStatus: string;
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;
let saved: string[];
let wrongPassword: boolean;

beforeEach(() => {
  permissions = ['clearance_files.view', 'invoices.view', 'payments.view', 'clients.view'];
  invStatus = 'ISSUED';
  calls = [];
  failNext = {};
  saved = [];
  wrongPassword = false;
  setLocale('en');
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
  (URL as any).createObjectURL = vi.fn(() => 'blob:x');
  (URL as any).revokeObjectURL = vi.fn();
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const [path, qs = ''] = url.replace('/api/v1', '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, query: new URLSearchParams(qs), body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/change-password' && wrongPassword) return fail(401, 'INVALID_CREDENTIALS', 'Current password is incorrect'); // the client retries once after a refresh and gets the same answer
    if (path === '/auth/logout') return res(204, null);
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'sara@demo.test', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'Demo Office', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: { id: 'b1', code: 'BEY', name: 'Beirut' }, roles: [{ id: 'r1', code: 'ACCOUNTANT', name: 'Accountant' }], permissions, availableTenants: [],
    });
    if (path === '/clearance-files/f1' && method === 'GET') return ok(FILE);
    if (path.endsWith('/transitions')) return ok({ currentStage: null, status: 'OPEN', transitions: [] });
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 0, containers: 0, goodsLines: 0, documents: 0, openTasks: 0 } });
    if (path === '/clearance-files/f1/invoices') return ok([INV(invStatus)], { page: 1, limit: 20, total: 1 });
    if (path === '/invoices/i1' && method === 'GET') return ok(INV(invStatus));
    if (path === '/invoices/i1/pdf') return pdf('INV-2026-00001.pdf');
    if (path === '/clients/c1') return ok({ id: 'c1', clientCode: 'CLT-00001', clientType: 'COMPANY', name: 'Al Nour Trading', legalName: null, taxNumber: null, registrationNumber: null, phone: null, email: null, address: null, countryCode: null, paymentTermsDays: 30, creditLimit: null, notes: null, isActive: true, contacts: [] });
    if (path === '/clients/c1/balance') return ok({ clientId: 'c1', creditLimit: null, balances: [{ currency: 'USD', invoiced: '100.0000', received: '0.0000', refunded: '0.0000', allocated: '0.0000', outstanding: '100.0000', unappliedCredit: '0.0000', netBalance: '100.0000' }] });
    if (path === '/clients/c1/statement') return ok({ openingBalances: {}, closingBalances: {}, lines: [] });
    if (path === '/clients/c1/statement/pdf') return pdf('statement-CLT-00001.pdf');
    if (method === 'POST') return ok({});
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mount = (path: string) => render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('invoice PDF', () => {
  const openInvoice = async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Invoices' }));
    await user.click(await screen.findByRole('button', { name: 'Show details INV-2026-00001' }));
    return user;
  };

  it('downloads an issued invoice in English or Arabic, with the server\'s file name', async () => {
    const user = await openInvoice();
    await user.click(await screen.findByRole('button', { name: 'PDF (English)' }));
    await waitFor(() => expect(saved).toEqual(['INV-2026-00001.pdf']));
    expect(sent('GET', '/invoices/i1/pdf')[0].query.get('locale')).toBe('en');
    expect(sent('GET', '/invoices/i1/pdf')[0].query.get('disposition')).toBe('attachment');
    await user.click(screen.getByRole('button', { name: 'PDF (Arabic)' }));
    await waitFor(() => expect(sent('GET', '/invoices/i1/pdf')).toHaveLength(2));
    expect(sent('GET', '/invoices/i1/pdf')[1].query.get('locale')).toBe('ar');
  });

  it('is not offered on a draft', async () => {
    invStatus = 'DRAFT';
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Invoices' }));
    await user.click(await screen.findByRole('button', { name: 'Show details Draft' }));
    await screen.findByRole('button', { name: 'Hide' }); // the details have loaded
    expect(screen.queryByRole('button', { name: 'PDF (English)' })).not.toBeInTheDocument();
  });

  it('shows the server message when printing fails', async () => {
    failNext['GET /invoices/i1/pdf'] = fail(500, 'PDF_FAILED', 'The PDF could not be produced');
    const user = await openInvoice();
    await user.click(await screen.findByRole('button', { name: 'PDF (English)' }));
    expect(await screen.findByText('The PDF could not be produced')).toBeInTheDocument();
  });
});

describe('client statement PDF', () => {
  it('prints the statement with the filters in use', async () => {
    mount('/clients/c1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Account' }));
    await screen.findByRole('cell', { name: 'USD' });
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await user.click(screen.getByRole('button', { name: 'PDF (Arabic)' }));
    await waitFor(() => expect(saved).toEqual(['statement-CLT-00001.pdf']));
    const q = sent('GET', '/clients/c1/statement/pdf')[0].query;
    expect(q.get('locale')).toBe('ar');
    expect(q.get('from')).toBe('2026-11-01');
    expect(q.get('format')).toBe('pdf');
  });
});

describe('my account', () => {
  it('is reached from the header and shows who I am here', async () => {
    mount('/');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: 'My account' }));
    expect(await screen.findByRole('heading', { name: 'My account', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('sara@demo.test')).toBeInTheDocument();
    expect(screen.getAllByText('Demo Office').length).toBeGreaterThan(0);
    expect(screen.getByText('Beirut')).toBeInTheDocument();
    expect(screen.getByText('Accountant')).toBeInTheDocument();
  });

  it('checks the form before sending, then asks to sign in again', async () => {
    mount('/account');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Enter your current password')).toBeInTheDocument();
    expect(sent('POST', '/auth/change-password')).toHaveLength(0);
    await user.type(screen.getByLabelText('Current password'), 'old-password-1');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat the new password'), 'different');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Use at least 10 characters')).toBeInTheDocument();
    expect(screen.getByText('The passwords do not match')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'old-password-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The new password must differ from the current one')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('New password'));
    await user.clear(screen.getByLabelText('Repeat the new password'));
    await user.type(screen.getByLabelText('New password'), 'brand-new-password');
    await user.type(screen.getByLabelText('Repeat the new password'), 'brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(sent('POST', '/auth/change-password')).toHaveLength(1));
    expect(sent('POST', '/auth/change-password')[0].body).toEqual({ currentPassword: 'old-password-1', newPassword: 'brand-new-password' });
    expect(await screen.findByText(/Your password was changed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows the server message when the current password is wrong', async () => {
    wrongPassword = true;
    mount('/account');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Current password'), 'wrong-password');
    await user.type(screen.getByLabelText('New password'), 'brand-new-password');
    await user.type(screen.getByLabelText('Repeat the new password'), 'brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('Current password is incorrect')).toBeInTheDocument();
    expect(screen.queryByText(/Your password was changed/)).not.toBeInTheDocument();
  });

  it('works in Arabic', async () => {
    setLocale('ar');
    mount('/account');
    expect(await screen.findByRole('heading', { name: 'حسابي', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تغيير كلمة المرور' })).toBeInTheDocument();
    expect(within(document.body).getByText('Accountant')).toBeInTheDocument();
  });
});
