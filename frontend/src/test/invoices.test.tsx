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

const FILE = (status = 'OPEN') => ({
  id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status, priority: 'NORMAL', openedAt: '2026-11-03T10:00:00.000+00:00', expectedArrivalAt: null, closedAt: null,
  customsReference: null, internalNotes: null, client: { id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading' }, branch: null,
  currentStage: { id: 's1', code: 'NEW_FILE', nameEn: 'New file', nameAr: null, isTerminal: false }, assignee: null, createdBy: null, workflowTemplate: null, shipments: [],
});
const INV = (over: Record<string, unknown> = {}) => ({
  id: 'i1', invoiceNumber: 'DRAFT-AB12CD34', invoiceType: 'STANDARD', status: 'DRAFT', currencyCode: 'USD', issueDate: null, dueDate: null, cancelReason: null,
  subtotal: '300.0000', discount: '0.0000', taxAmount: '0.0000', totalAmount: '300.0000', paidAmount: '0.0000', outstandingAmount: '300.0000', paymentStatus: null, isOverdue: false,
  items: [{ id: 'it1', description: 'Clearance fee', categoryId: 'cat1', category: { id: 'cat1', name: 'Clearance service' }, quantity: '1.0000', unitPrice: '300.0000', amount: '300.0000', taxAmount: '0.0000', expenseId: null }],
  ...over,
});
const CATS = [
  { id: 'cat1', name: 'Clearance service', costTreatment: 'OFFICE_REVENUE', isBillableToClient: true, isActive: true },
  { id: 'cat2', name: 'Port fees', costTreatment: 'PASS_THROUGH', isBillableToClient: true, isActive: true },
  { id: 'cat3', name: 'Office rent', costTreatment: 'OFFICE_EXPENSE', isBillableToClient: false, isActive: true },
];
const slim = (c: (typeof CATS)[number]) => ({ id: c.id, name: c.name, costTreatment: c.costTreatment }); // the expense list does not carry isBillableToClient
const EXPENSES = [
  { id: 'x1', description: 'Port fee 40ft', amount: '120.0000', currencyCode: 'USD', category: slim(CATS[1]) },
  { id: 'x2', description: 'Wrong currency', amount: '9000000.0000', currencyCode: 'LBP', category: slim(CATS[1]) },
  { id: 'x3', description: 'Our own cost', amount: '50.0000', currencyCode: 'USD', category: slim(CATS[2]) },
];

const ALL = ['clearance_files.view', 'invoices.view', 'invoices.create', 'invoices.issue', 'expenses.view'];
let permissions: string[];
let fileStatus: string;
let invoices: ReturnType<typeof INV>[];
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...ALL];
  fileStatus = 'OPEN';
  invoices = [INV()];
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/v1', '').split('?')[0];
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/clearance-files/f1' && method === 'GET') return ok(FILE(fileStatus));
    if (path.endsWith('/transitions')) return ok({ currentStage: null, status: fileStatus, transitions: [] });
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 0, containers: 0, goodsLines: 0, documents: 0, openTasks: 0 } });
    if (path === '/clearance-files/f1/invoices') return ok(invoices, { page: 1, limit: 20, total: invoices.length });
    if (path === '/invoices/i1' && method === 'GET') return ok(invoices[0]);
    if (path === '/currencies') return ok([{ code: 'USD', name: 'US dollar', decimalPlaces: 2 }, { code: 'LBP', name: 'Lebanese pound', decimalPlaces: 0 }]);
    if (path === '/financial-categories') return ok(CATS);
    if (path === '/expenses') return ok(EXPENSES, { page: 1, limit: 100, total: EXPENSES.length });
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'i2' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async () => {
  render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Invoices' }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const expand = async (user: ReturnType<typeof userEvent.setup>, label: string) => user.click(await screen.findByRole('button', { name: `Show details ${label}` }));

describe('invoice list', () => {
  it('shows drafts as drafts, with totals', async () => {
    await open();
    const row = (await screen.findByText('Draft', { selector: 'td' })).closest('tr')!;
    expect(within(row).getByText('Standard')).toBeInTheDocument();
    expect(within(row).getByText('300.00 USD')).toBeInTheDocument();
  });

  it('shows issued invoices with payment state and overdue', async () => {
    invoices = [INV({ id: 'i1', invoiceNumber: 'INV-2026-00001', status: 'ISSUED', paymentStatus: 'PARTIALLY_PAID', paidAmount: '100.0000', outstandingAmount: '200.0000', isOverdue: true, dueDate: '2026-10-01T12:00:00.000Z' })];
    await open();
    const row = (await screen.findByText('INV-2026-00001')).closest('tr')!;
    expect(within(row).getByText('Partly paid')).toBeInTheDocument();
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(within(row).getByText('200.00 USD')).toBeInTheDocument();
  });

  it('hides the tab without invoices.view', async () => {
    permissions = ['clearance_files.view'];
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: 'Invoices' })).not.toBeInTheDocument();
  });
});

describe('creating a draft', () => {
  it('sends a service line and an expense re-billed at cost, offering only matching expenses', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New draft invoice' }));
    const form = (await screen.findByRole('heading', { name: 'New draft invoice', level: 2 })).closest('form')!;

    await user.click(within(form).getByRole('button', { name: 'Create draft' }));
    expect(await within(form).findByText('Enter a description')).toBeInTheDocument();
    expect(sent('POST', '/invoices')).toHaveLength(0);

    await user.type(within(form).getByLabelText('Description'), 'Customs clearance');
    await user.selectOptions(within(form).getByLabelText('Category'), 'cat1');
    await user.type(within(form).getByLabelText('Unit price'), '300');
    const add = within(form).getByLabelText('Add an expense at cost');
    await waitFor(() => expect(within(add).getByRole('option', { name: /Port fee 40ft/ })).toBeInTheDocument());
    expect(within(add).queryByRole('option', { name: /Wrong currency/ })).not.toBeInTheDocument(); // other currency
    expect(within(add).queryByRole('option', { name: /Our own cost/ })).not.toBeInTheDocument(); // not pass-through
    await user.selectOptions(add, 'x1');
    expect(within(form).getByText('Port fee 40ft')).toBeInTheDocument();

    await user.click(within(form).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(sent('POST', '/invoices')).toHaveLength(1));
    expect(sent('POST', '/invoices')[0].body).toEqual({
      clearanceFileId: 'f1', invoiceType: 'STANDARD', currencyCode: 'USD', discount: '0',
      items: [{ description: 'Customs clearance', categoryId: 'cat1', quantity: '1', unitPrice: '300' }, { expenseId: 'x1' }],
    });
  });

  it('an advance invoice has no categories, discount or expenses', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New draft invoice' }));
    const form = (await screen.findByRole('heading', { name: 'New draft invoice', level: 2 })).closest('form')!;
    await user.selectOptions(within(form).getByLabelText('Type'), 'ADVANCE');
    expect(within(form).queryByLabelText('Category')).not.toBeInTheDocument();
    expect(within(form).getByLabelText('Discount')).toBeDisabled();
    expect(within(form).queryByLabelText('Add an expense at cost')).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText('Description'), 'Advance for duties');
    await user.type(within(form).getByLabelText('Unit price'), '1000');
    await user.click(within(form).getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(sent('POST', '/invoices')).toHaveLength(1));
    expect(sent('POST', '/invoices')[0].body.invoiceType).toBe('ADVANCE');
  });

  it('shows the server message when it refuses', async () => {
    failNext['POST /invoices'] = fail(422, 'DISCOUNT_TOO_LARGE', 'The discount cannot exceed the service-fee total (300.0000)');
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New draft invoice' }));
    const form = (await screen.findByRole('heading', { name: 'New draft invoice', level: 2 })).closest('form')!;
    await user.type(within(form).getByLabelText('Description'), 'Fee');
    await user.selectOptions(within(form).getByLabelText('Category'), 'cat1');
    await user.type(within(form).getByLabelText('Unit price'), '10');
    await user.click(within(form).getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText(/cannot exceed the service-fee total/)).toBeInTheDocument();
  });

  it('is not offered without invoices.create or on a closed file', async () => {
    permissions = ['clearance_files.view', 'invoices.view'];
    await open();
    await screen.findByText('300.00 USD');
    expect(screen.queryByRole('button', { name: 'New draft invoice' })).not.toBeInTheDocument();
  });
});

describe('working with an invoice', () => {
  it('edits a draft, sending its lines back', async () => {
    const user = await open();
    await expand(user, 'Draft');
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = (await screen.findByRole('heading', { name: 'Edit draft invoice' })).closest('form')!;
    expect(within(form).getByLabelText('Description')).toHaveValue('Clearance fee');
    await user.clear(within(form).getByLabelText('Unit price'));
    await user.type(within(form).getByLabelText('Unit price'), '350');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/invoices/i1')).toHaveLength(1));
    expect(sent('PATCH', '/invoices/i1')[0].body).toMatchObject({ dueDate: null, items: [{ description: 'Clearance fee', categoryId: 'cat1', quantity: '1', unitPrice: '350' }] });
  });

  it('issues a draft', async () => {
    const user = await open();
    await expand(user, 'Draft');
    await user.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    await waitFor(() => expect(sent('POST', '/invoices/i1/issue')).toHaveLength(1));
  });

  it('cancels an issued invoice only with a reason, and shows the refusal when payments exist', async () => {
    invoices = [INV({ invoiceNumber: 'INV-2026-00001', status: 'ISSUED', paymentStatus: 'UNPAID' })];
    failNext['POST /invoices/i1/cancel'] = fail(409, 'INVOICE_HAS_ALLOCATIONS', 'Reverse the payment allocations on this invoice before cancelling it');
    const user = await open();
    await expand(user, 'INV-2026-00001');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument(); // issued invoices are frozen
    await user.click(await screen.findByRole('button', { name: 'Cancel invoice' }));
    const confirm = screen.getAllByRole('button', { name: 'Cancel invoice' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for cancelling'), 'Wrong client');
    await user.click(confirm);
    expect(await screen.findByText(/Reverse the payment allocations/)).toBeInTheDocument();
    expect(sent('POST', '/invoices/i1/cancel')[0].body).toEqual({ reason: 'Wrong client' });
  });

  it('cannot issue or cancel without invoices.issue', async () => {
    permissions = ['clearance_files.view', 'invoices.view', 'invoices.create'];
    const user = await open();
    await expand(user, 'Draft');
    await screen.findByRole('button', { name: 'Edit' });
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });

  it('is read-only on a closed file', async () => {
    fileStatus = 'CLOSED';
    const user = await open();
    expect(await screen.findByText(/invoices cannot be changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New draft invoice' })).not.toBeInTheDocument();
    await expand(user, 'Draft');
    await screen.findByText('Clearance fee');
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the tab and list in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'الفواتير' }));
    expect(await screen.findByText('مسودة', { selector: 'span' })).toBeInTheDocument();
  });
});
