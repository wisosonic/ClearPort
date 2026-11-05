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
const PAY = (over: Record<string, unknown> = {}) => ({
  id: 'p1', paymentNumber: 'PAY-2026-00001', paymentType: 'CLIENT_PAYMENT', status: 'POSTED', amount: '500.0000', currencyCode: 'USD', paymentDate: '2026-11-03T12:00:00.000Z',
  paymentMethod: 'BANK_TRANSFER', referenceNumber: 'TRX-889', cashAccount: { id: 'ca1', name: 'Main bank (USD)' }, allocatedAmount: '0.0000', unallocatedAmount: '500.0000', allocations: [], ...over,
});
const OPEN_INV = [
  { id: 'i1', invoiceNumber: 'INV-2026-00001', invoiceType: 'STANDARD', currencyCode: 'USD', outstandingAmount: '290.0000', status: 'ISSUED' },
  { id: 'i2', invoiceNumber: 'INV-2026-00002', invoiceType: 'STANDARD', currencyCode: 'LBP', outstandingAmount: '9000000.0000', status: 'ISSUED' },
  { id: 'i3', invoiceNumber: 'INV-2026-00003', invoiceType: 'ADVANCE', currencyCode: 'USD', outstandingAmount: '1000.0000', status: 'ISSUED' },
  { id: 'i4', invoiceNumber: 'INV-2026-00004', invoiceType: 'STANDARD', currencyCode: 'USD', outstandingAmount: '0.0000', status: 'ISSUED' },
];
const ACCOUNTS = [
  { id: 'ca1', name: 'Main bank (USD)', accountType: 'BANK', currencyCode: 'USD', isActive: true },
  { id: 'ca2', name: 'Cashbox (LBP)', accountType: 'CASHBOX', currencyCode: 'LBP', isActive: true },
  { id: 'ca3', name: 'Old USD box', accountType: 'CASHBOX', currencyCode: 'USD', isActive: false },
];

const ALL = ['clearance_files.view', 'payments.view', 'payments.create', 'invoices.view'];
let permissions: string[];
let fileStatus: string;
let payments: Record<string, unknown>[];
let detail: Record<string, unknown>;
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...ALL];
  fileStatus = 'OPEN';
  payments = [PAY()];
  detail = PAY();
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
    if (path === '/payments' && method === 'GET') return ok(payments, { page: 1, limit: 20, total: payments.length });
    if (path === '/payments/p1' && method === 'GET') return ok(detail);
    if (path === '/invoices' && method === 'GET') return ok([
      { id: 'ad1', invoiceNumber: 'INV-2026-00007', invoiceType: 'ADVANCE', currencyCode: 'USD', outstandingAmount: '500.0000', status: 'ISSUED' },
      { id: 'ad2', invoiceNumber: 'INV-2026-00008', invoiceType: 'ADVANCE', currencyCode: 'LBP', outstandingAmount: '9000000.0000', status: 'ISSUED' },
      { id: 'ad3', invoiceNumber: 'INV-2026-00009', invoiceType: 'ADVANCE', currencyCode: 'USD', outstandingAmount: '0.0000', status: 'ISSUED' },
    ], { page: 1, limit: 50, total: 3 });
    if (path === '/payment-methods') return ok([{ code: 'CASH', nameEn: 'Cash', nameAr: 'نقداً' }, { code: 'WIRE', nameEn: 'Wire (new)', nameAr: 'حوالة' }]);
    if (path === '/clearance-files/f1/invoices') return ok(OPEN_INV, { page: 1, limit: 100, total: OPEN_INV.length });
    if (path === '/currencies') return ok([{ code: 'USD', name: 'US dollar', decimalPlaces: 2 }, { code: 'LBP', name: 'Lebanese pound', decimalPlaces: 0 }]);
    if (path === '/cash-accounts') return ok(ACCOUNTS);
    if (method === 'POST') return ok({ id: 'p2' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async () => {
  render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Payments' }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const expand = async (user: ReturnType<typeof userEvent.setup>) => user.click(await screen.findByRole('button', { name: 'Show details PAY-2026-00001' }));
const recordForm = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole('button', { name: 'Record payment' }));
  return (await screen.findByRole('heading', { name: 'Record payment', level: 2, hidden: false })).closest('form') ?? (await screen.findByLabelText('Amount')).closest('form')!;
};

describe('payment list', () => {
  it('shows the payment with method, reference and that it is not fully applied', async () => {
    await open();
    const row = (await screen.findByText('PAY-2026-00001')).closest('tr')!;
    expect(within(row).getByText('Payment')).toBeInTheDocument();
    expect(within(row).getByText('Bank transfer')).toBeInTheDocument();
    expect(within(row).getByText('TRX-889')).toBeInTheDocument();
    expect(within(row).getByText('500.00 USD')).toBeInTheDocument();
    expect(within(row).getByText('Not fully applied')).toBeInTheDocument();
    expect(sent('GET', '/payments')).toHaveLength(1);
  });

  it('hides the tab without payments.view', async () => {
    permissions = ['clearance_files.view'];
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: 'Payments' })).not.toBeInTheDocument();
  });
});

describe('recording', () => {
  it('needs an amount and an account in the chosen currency, then records for the file client', async () => {
    const user = await open();
    const form = await recordForm(user);
    await user.click(within(form).getByRole('button', { name: 'Record payment' }));
    expect(await within(form).findByText(/Enter an amount above zero/)).toBeInTheDocument();
    expect(sent('POST', '/payments')).toHaveLength(0);

    const cash = within(form).getByLabelText('Cash or bank account') as HTMLSelectElement;
    await waitFor(() => expect(within(cash).getByRole('option', { name: 'Main bank (USD)' })).toBeInTheDocument());
    expect(within(cash).queryByRole('option', { name: 'Old USD box' })).not.toBeInTheDocument(); // inactive
    expect(within(cash).queryByRole('option', { name: 'Cashbox (LBP)' })).not.toBeInTheDocument(); // other currency
    expect(cash.value).toBe('ca1'); // the only match is chosen for the clerk

    await user.type(within(form).getByLabelText('Amount'), '250.5');
    await user.type(within(form).getByLabelText(/Reference/), 'CHQ 1042');
    await user.click(within(form).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(sent('POST', '/payments')).toHaveLength(1));
    expect(sent('POST', '/payments')[0].body).toMatchObject({
      clientId: 'c1', clearanceFileId: 'f1', paymentType: 'CLIENT_PAYMENT', amount: '250.5', currencyCode: 'USD', cashAccountId: 'ca1', paymentMethod: 'CASH', referenceNumber: 'CHQ 1042',
    });
  });

  it('lists the payment methods from the API, including ones the interface has no name for', async () => {
    const user = await open();
    const form = await recordForm(user);
    const method = within(form).getByLabelText('Method');
    await waitFor(() => expect(within(method).getByRole('option', { name: 'Wire (new)' })).toBeInTheDocument());
  });

  it('lets an advance answer an open advance invoice of the same currency', async () => {
    const user = await open();
    const form = await recordForm(user);
    expect(within(form).queryByLabelText('Answers advance invoice')).not.toBeInTheDocument(); // not for a normal payment
    await user.selectOptions(within(form).getByLabelText('Type'), 'CLIENT_ADVANCE');
    const pick = await within(form).findByLabelText('Answers advance invoice');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['—', 'INV-2026-00007 · 500.0000 USD']); // not LBP, not settled
    await user.selectOptions(pick, 'ad1');
    await waitFor(() => expect((within(form).getByLabelText('Cash or bank account') as HTMLSelectElement).value).toBe('ca1'));
    await user.type(within(form).getByLabelText('Amount'), '500');
    await user.click(within(form).getByRole('button', { name: 'Record payment' }));
    await waitFor(() => expect(sent('POST', '/payments')).toHaveLength(1));
    expect(sent('POST', '/payments')[0].body).toMatchObject({ paymentType: 'CLIENT_ADVANCE', advanceInvoiceId: 'ad1' });
  });

  it('switching currency changes the accounts offered', async () => {
    const user = await open();
    const form = await recordForm(user);
    await waitFor(() => expect(within(form.querySelector('select#pay-cash') as HTMLElement).getByRole('option', { name: 'Main bank (USD)' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Currency'), 'LBP');
    expect(within(within(form).getByLabelText('Cash or bank account')).getByRole('option', { name: 'Cashbox (LBP)' })).toBeInTheDocument();
    expect((within(form).getByLabelText('Cash or bank account') as HTMLSelectElement).value).toBe('ca2');
  });

  it('records a refund and shows the server message when credit is short', async () => {
    failNext['POST /payments'] = fail(422, 'INSUFFICIENT_CREDIT', 'The client has only 0.0000 USD of unapplied credit to refund');
    const user = await open();
    const form = await recordForm(user);
    await user.selectOptions(within(form).getByLabelText('Type'), 'REFUND');
    await waitFor(() => expect((within(form).getByLabelText('Cash or bank account') as HTMLSelectElement).value).toBe('ca1'));
    await user.type(within(form).getByLabelText('Amount'), '100');
    await user.click(within(form).getByRole('button', { name: 'Record payment' }));
    expect(await screen.findByText(/only 0.0000 USD of unapplied credit/)).toBeInTheDocument();
    expect(sent('POST', '/payments')[0].body.paymentType).toBe('REFUND');
  });

  it('is not offered without payments.create or on a closed file', async () => {
    permissions = ['clearance_files.view', 'payments.view'];
    await open();
    await screen.findByText('PAY-2026-00001');
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });
});

describe('applying to invoices', () => {
  it('offers only issued, non-advance invoices with something outstanding, and sends the amounts', async () => {
    const user = await open();
    await expand(user);
    await user.click(await screen.findByRole('button', { name: 'Apply to invoices' }));
    expect(await screen.findByText('INV-2026-00001')).toBeInTheDocument();
    expect(screen.queryByText('INV-2026-00003')).not.toBeInTheDocument(); // advance invoice
    expect(screen.queryByText('INV-2026-00004')).not.toBeInTheDocument(); // nothing outstanding

    await user.click(screen.getAllByRole('button', { name: 'Apply to invoices' }).at(-1)!);
    expect(await screen.findByText('Enter an amount for at least one invoice')).toBeInTheDocument();
    expect(sent('POST', '/payments/p1/allocate')).toHaveLength(0);

    await user.type(document.getElementById('alloc-i1') as HTMLElement, '290');
    await user.type(document.getElementById('alloc-i2') as HTMLElement, '100');
    expect(document.getElementById('cred-i2')).not.toBeNull(); // other currency: the credited amount can be given
    expect(document.getElementById('cred-i1')).toBeNull();
    await user.type(document.getElementById('cred-i2') as HTMLElement, '8900000');
    await user.click(screen.getAllByRole('button', { name: 'Apply to invoices' }).at(-1)!);
    await waitFor(() => expect(sent('POST', '/payments/p1/allocate')).toHaveLength(1));
    expect(sent('POST', '/payments/p1/allocate')[0].body).toEqual({
      allocations: [{ invoiceId: 'i1', amount: '290' }, { invoiceId: 'i2', amount: '100', invoiceAmount: '8900000' }],
    });
  });

  it('shows the server refusal', async () => {
    failNext['POST /payments/p1/allocate'] = fail(422, 'OVER_ALLOCATION', 'Invoice INV-2026-00001 has only 290.0000 USD outstanding');
    const user = await open();
    await expand(user);
    await user.click(await screen.findByRole('button', { name: 'Apply to invoices' }));
    await user.type(await screen.findByLabelText('Amount (USD)', { selector: '#alloc-i1' }), '400');
    await user.click(screen.getAllByRole('button', { name: 'Apply to invoices' }).at(-1)!);
    expect(await screen.findByText(/has only 290.0000 USD outstanding/)).toBeInTheDocument();
  });

  it('is not offered when nothing is left to apply', async () => {
    detail = PAY({ allocatedAmount: '500.0000', unallocatedAmount: '0.0000', allocations: [] });
    const user = await open();
    await expand(user);
    await screen.findByText(/Still held for the client/);
    expect(screen.queryByRole('button', { name: 'Apply to invoices' })).not.toBeInTheDocument();
  });
});

describe('reversing and cancelling', () => {
  const applied = () => PAY({
    allocatedAmount: '290.0000', unallocatedAmount: '210.0000',
    allocations: [{ id: 'a1', invoiceId: 'i1', invoice: { id: 'i1', invoiceNumber: 'INV-2026-00001', currencyCode: 'USD', invoiceType: 'STANDARD' }, paymentAmount: '290.0000', allocatedAmount: '290.0000', currencyCode: 'USD', reversedAt: null, reversalReason: null }],
  });

  it('reverses an allocation only with a reason; cancelling is offered only when none is live', async () => {
    detail = applied();
    const user = await open();
    await expand(user);
    expect(await screen.findByText(/Applied to invoices: 290.00 USD/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel payment' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reverse INV-2026-00001' }));
    const confirm = screen.getAllByRole('button', { name: 'Reverse' }).at(-1)!;
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for reversing this allocation'), 'Applied to wrong invoice');
    await user.click(confirm);
    await waitFor(() => expect(sent('POST', '/payments/p1/allocations/a1/reverse')).toHaveLength(1));
    expect(sent('POST', '/payments/p1/allocations/a1/reverse')[0].body).toEqual({ reason: 'Applied to wrong invoice' });
  });

  it('cancels a payment with a reason', async () => {
    const user = await open();
    await expand(user);
    await user.click(await screen.findByRole('button', { name: 'Cancel payment' }));
    await user.type(screen.getByLabelText('Reason for cancelling this payment'), 'Cheque bounced');
    await user.click(screen.getAllByRole('button', { name: 'Cancel payment' }).at(-1)!);
    await waitFor(() => expect(sent('POST', '/payments/p1/cancel')).toHaveLength(1));
    expect(sent('POST', '/payments/p1/cancel')[0].body).toEqual({ reason: 'Cheque bounced' });
  });

  it('shows a reversed allocation as reversed, with no actions', async () => {
    const d: any = applied(); d.allocations[0].reversedAt = '2026-11-04T10:00:00.000Z';
    detail = d;
    const user = await open();
    await expand(user);
    expect(await screen.findByText('Reversed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reverse INV-2026-00001' })).not.toBeInTheDocument();
  });

  it('can only be viewed without payments.create, and is read-only on a closed file', async () => {
    permissions = ['clearance_files.view', 'payments.view'];
    const user = await open();
    await expand(user);
    await screen.findByText(/Still held for the client/);
    expect(screen.queryByRole('button', { name: 'Cancel payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply to invoices' })).not.toBeInTheDocument();
  });

  it('is read-only on a closed file', async () => {
    fileStatus = 'CLOSED';
    const user = await open();
    expect(await screen.findByText(/payments cannot be changed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    await expand(user);
    await screen.findByText(/Still held for the client/);
    expect(screen.queryByRole('button', { name: 'Apply to invoices' })).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the tab and list in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'الدفعات' }));
    expect(await screen.findByText('تحويل مصرفي')).toBeInTheDocument();
  });
});
