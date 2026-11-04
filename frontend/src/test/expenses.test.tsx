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
const PORT = { id: 'cat2', name: 'Port fees', costTreatment: 'PASS_THROUGH', isBillableToClient: true, isActive: true };
const CATS = [
  { id: 'cat1', name: 'Clearance service fees', costTreatment: 'OFFICE_REVENUE', isBillableToClient: true, isActive: true },
  PORT,
  { id: 'cat3', name: 'Office expenses', costTreatment: 'OFFICE_EXPENSE', isBillableToClient: false, isActive: true },
  { id: 'cat4', name: 'Retired', costTreatment: 'PASS_THROUGH', isBillableToClient: true, isActive: false },
];
const EXP = (over: Record<string, unknown> = {}) => ({
  id: 'x1', description: 'Port fee 40ft', amount: '120.0000', currencyCode: 'USD', expenseDate: '2026-11-03T12:00:00.000Z', status: 'DRAFT', paymentStatus: 'UNPAID', paidAt: null,
  categoryId: 'cat2', category: { id: 'cat2', name: 'Port fees', costTreatment: 'PASS_THROUGH' }, cashAccount: null, isBilled: false, billedOn: null, ...over,
});
const ACCOUNTS = [
  { id: 'ca1', name: 'USD cashbox', accountType: 'CASHBOX', currencyCode: 'USD', isActive: true },
  { id: 'ca2', name: 'LBP cashbox', accountType: 'CASHBOX', currencyCode: 'LBP', isActive: true },
];

const ALL = ['clearance_files.view', 'expenses.view', 'expenses.create', 'expenses.approve', 'payments.view'];
let permissions: string[];
let fileStatus: string;
let expenses: Record<string, unknown>[];
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...ALL];
  fileStatus = 'OPEN';
  expenses = [EXP()];
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
    if (path === '/expenses' && method === 'GET') return ok(expenses, { page: 1, limit: 20, total: expenses.length });
    if (path === '/currencies') return ok([{ code: 'USD', name: 'US dollar', decimalPlaces: 2 }, { code: 'LBP', name: 'Lebanese pound', decimalPlaces: 0 }]);
    if (path === '/financial-categories') return ok(CATS);
    if (path === '/cash-accounts') return ok(ACCOUNTS);
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x2' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async () => {
  render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Expenses' }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('expense list', () => {
  it('shows the expense with its category, amount and state', async () => {
    expenses = [EXP(), EXP({ id: 'x2', description: 'Storage', status: 'APPROVED', paymentStatus: 'PAID', isBilled: true, billedOn: { id: 'i1', invoiceNumber: 'INV-2026-00001', status: 'ISSUED' } })];
    await open();
    const row = (await screen.findByText('Port fee 40ft')).closest('tr')!;
    expect(within(row).getByText('Port fees')).toBeInTheDocument();
    expect(within(row).getByText('120.00 USD')).toBeInTheDocument();
    expect(within(row).getByText('Draft')).toBeInTheDocument();
    const billed = screen.getByText('Storage').closest('tr')!;
    expect(within(billed).getByText('Approved')).toBeInTheDocument();
    expect(within(billed).getByText('Paid')).toBeInTheDocument();
    expect(within(billed).getByText('On INV-2026-00001')).toBeInTheDocument();
    expect(within(billed).queryByRole('button', { name: /Cancel expense/ })).not.toBeInTheDocument(); // billed: cancel the invoice first
  });

  it('hides the tab without expenses.view', async () => {
    permissions = ['clearance_files.view'];
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: 'Expenses' })).not.toBeInTheDocument();
  });
});

describe('recording and editing', () => {
  it('asks for category, description and amount, offers only cost categories, and links the file', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Record expense' }));
    const form = (await screen.findByRole('heading', { name: 'Record expense', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Record expense' }));
    expect(await within(form).findByText('Choose a category')).toBeInTheDocument();
    expect(sent('POST', '/expenses')).toHaveLength(0);

    const cat = within(form).getByLabelText('Category');
    await waitFor(() => expect(within(cat).getByRole('option', { name: 'Port fees' })).toBeInTheDocument());
    expect(within(cat).queryByRole('option', { name: 'Clearance service fees' })).not.toBeInTheDocument(); // a fee the office earns
    expect(within(cat).queryByRole('option', { name: 'Retired' })).not.toBeInTheDocument(); // inactive
    await user.selectOptions(cat, 'cat2');
    expect(within(form).getByText(/re-billed at cost/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Description'), 'Crane hire');
    await user.type(within(form).getByLabelText('Amount'), '75.5');
    await user.click(within(form).getByRole('button', { name: 'Record expense' }));
    await waitFor(() => expect(sent('POST', '/expenses')).toHaveLength(1));
    expect(sent('POST', '/expenses')[0].body).toMatchObject({ clearanceFileId: 'f1', categoryId: 'cat2', description: 'Crane hire', amount: '75.5', currencyCode: 'USD' });
  });

  it('shows the server refusal', async () => {
    failNext['POST /expenses'] = fail(422, 'FILE_REQUIRED_FOR_PASS_THROUGH', 'A pass-through expense must be linked to a clearance file');
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Record expense' }));
    const form = (await screen.findByRole('heading', { name: 'Record expense', level: 2 })).closest('form')!;
    await waitFor(() => expect(within(within(form).getByLabelText('Category')).getByRole('option', { name: 'Port fees' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Category'), 'cat2');
    await user.type(within(form).getByLabelText('Description'), 'x');
    await user.type(within(form).getByLabelText('Amount'), '1');
    await user.click(within(form).getByRole('button', { name: 'Record expense' }));
    expect(await screen.findByText(/must be linked to a clearance file/)).toBeInTheDocument();
  });

  it('edits only a draft expense', async () => {
    expenses = [EXP(), EXP({ id: 'x2', description: 'Storage', status: 'APPROVED' })];
    const user = await open();
    expect(screen.queryByRole('button', { name: 'Edit Storage' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Edit Port fee 40ft' }));
    const form = (await screen.findByRole('heading', { name: 'Edit draft expense' })).closest('form')!;
    expect(within(form).getByLabelText('Amount')).toHaveValue('120');
    await user.clear(within(form).getByLabelText('Amount'));
    await user.type(within(form).getByLabelText('Amount'), '130');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/expenses/x1')).toHaveLength(1));
    expect(sent('PATCH', '/expenses/x1')[0].body).toMatchObject({ amount: '130', categoryId: 'cat2', description: 'Port fee 40ft' });
  });

  it('is not offered without expenses.create', async () => {
    permissions = ['clearance_files.view', 'expenses.view'];
    await open();
    await screen.findByText('Port fee 40ft');
    expect(screen.queryByRole('button', { name: 'Record expense' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });
});

describe('approving, paying, cancelling', () => {
  it('approves as a payable by default, or paid from an account in the expense currency', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Approve Port fee 40ft' }));
    const pick = await screen.findByLabelText('Paid from');
    await waitFor(() => expect(within(pick).getByRole('option', { name: 'USD cashbox' })).toBeInTheDocument());
    expect(within(pick).queryByRole('option', { name: 'LBP cashbox' })).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!);
    await waitFor(() => expect(sent('POST', '/expenses/x1/approve')).toHaveLength(1));
    expect(sent('POST', '/expenses/x1/approve')[0].body).toEqual({});

    await user.click(await screen.findByRole('button', { name: 'Approve Port fee 40ft' }));
    await user.selectOptions(await screen.findByLabelText('Paid from'), 'ca1');
    await user.click(screen.getAllByRole('button', { name: 'Approve' }).at(-1)!);
    await waitFor(() => expect(sent('POST', '/expenses/x1/approve')).toHaveLength(2));
    expect(sent('POST', '/expenses/x1/approve')[1].body).toEqual({ cashAccountId: 'ca1' });
  });

  it('marks an approved payable as paid, which needs an account', async () => {
    expenses = [EXP({ status: 'APPROVED', paymentStatus: 'UNPAID' })];
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Mark as paid Port fee 40ft' }));
    const confirm = screen.getAllByRole('button', { name: 'Mark as paid' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.selectOptions(await screen.findByLabelText('Paid from'), 'ca1');
    await user.click(confirm);
    await waitFor(() => expect(sent('POST', '/expenses/x1/pay')).toHaveLength(1));
    expect(sent('POST', '/expenses/x1/pay')[0].body).toEqual({ cashAccountId: 'ca1' });
  });

  it('cancels only with a reason and shows the refusal', async () => {
    failNext['POST /expenses/x1/cancel'] = fail(409, 'EXPENSE_ALREADY_BILLED', 'This expense is on invoice INV-2026-00001; cancel or edit that invoice first');
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Cancel expense Port fee 40ft' }));
    const confirm = screen.getAllByRole('button', { name: 'Cancel expense' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for cancelling this expense'), 'Duplicate');
    await user.click(confirm);
    expect(await screen.findByText(/cancel or edit that invoice first/)).toBeInTheDocument();
    expect(sent('POST', '/expenses/x1/cancel')[0].body).toEqual({ reason: 'Duplicate' });
  });

  it('cannot approve without expenses.approve, and an approver without payments.view cannot pick an account', async () => {
    permissions = ['clearance_files.view', 'expenses.view', 'expenses.create'];
    await open();
    await screen.findByText('Port fee 40ft');
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });

  it('is read-only on a closed file', async () => {
    fileStatus = 'CLOSED';
    await open();
    expect(await screen.findByText(/expenses cannot be changed/)).toBeInTheDocument();
    await screen.findByText('Port fee 40ft');
    expect(screen.queryByRole('button', { name: 'Record expense' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve/ })).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the tab and list in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'المصاريف' }));
    expect(await screen.findByText('مسودة', { selector: 'span' })).toBeInTheDocument();
  });
});
