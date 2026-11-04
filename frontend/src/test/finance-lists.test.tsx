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

const INVOICES = [
  { id: 'i1', invoiceNumber: 'INV-2026-00001', invoiceType: 'STANDARD', status: 'ISSUED', currencyCode: 'USD', dueDate: '2026-10-01T12:00:00.000Z', totalAmount: '290.0000', outstandingAmount: '190.0000', paymentStatus: 'PARTIALLY_PAID', isOverdue: true, client: { id: 'c1', name: 'Al Nour Trading' }, clearanceFile: { id: 'f1', fileNumber: 'IMP-2026-00001' } },
  { id: 'i2', invoiceNumber: 'DRAFT-AB12CD34', invoiceType: 'ADVANCE', status: 'DRAFT', currencyCode: 'LBP', dueDate: null, totalAmount: '9000000.0000', outstandingAmount: '9000000.0000', paymentStatus: null, isOverdue: false, client: { id: 'c1', name: 'Al Nour Trading' }, clearanceFile: { id: 'f1', fileNumber: 'IMP-2026-00001' } },
];
const PAYMENTS = [
  { id: 'p1', paymentNumber: 'PAY-2026-00001', paymentType: 'CLIENT_PAYMENT', status: 'POSTED', amount: '500.0000', currencyCode: 'USD', paymentDate: '2026-11-03T12:00:00.000Z', paymentMethod: 'BANK_TRANSFER', referenceNumber: 'TRX-889', unallocatedAmount: '210.0000', clearanceFileId: 'f1', client: { id: 'c1', name: 'Al Nour Trading' } },
  { id: 'p2', paymentNumber: 'PAY-2026-00002', paymentType: 'CLIENT_ADVANCE', status: 'POSTED', amount: '100.0000', currencyCode: 'USD', paymentDate: '2026-11-04T12:00:00.000Z', paymentMethod: 'CASH', referenceNumber: null, unallocatedAmount: '0.0000', clearanceFileId: null, client: { id: 'c1', name: 'Al Nour Trading' } },
];

let permissions: string[];
let calls: { path: string; query: URLSearchParams }[];

beforeEach(() => {
  permissions = ['invoices.view', 'payments.view'];
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
    if (path === '/invoices') return ok(INVOICES, { page: 1, limit: 20, total: 2 });
    if (path === '/payments') return ok(PAYMENTS, { page: 1, limit: 20, total: 2 });
    return res(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route', details: [] } });
  }));
});

const mount = (path: string) => render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const last = (path: string) => calls.filter((c) => c.path === path).at(-1)!.query;

describe('invoices page', () => {
  it('lists every invoice with client and file links, state and amounts', async () => {
    mount('/invoices');
    const row = (await screen.findByText('INV-2026-00001')).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'Al Nour Trading' })).toHaveAttribute('href', '/clients/c1');
    expect(within(row).getByRole('link', { name: 'IMP-2026-00001' })).toHaveAttribute('href', '/files/f1');
    expect(within(row).getByText('Partly paid')).toBeInTheDocument();
    expect(within(row).getByText('Overdue')).toBeInTheDocument();
    expect(within(row).getByText('190.00 USD')).toBeInTheDocument();
    const draft = screen.getByText('Draft', { selector: 'td' }).closest('tr')!;
    expect(within(draft).getByText('Advance')).toBeInTheDocument();
    expect(within(draft).getByText('9,000,000 LBP')).toBeInTheDocument();
  });

  it('sends the filters to the API', async () => {
    mount('/invoices');
    const user = userEvent.setup();
    await screen.findByText('INV-2026-00001');
    await user.selectOptions(screen.getByLabelText('Status'), 'ISSUED');
    await user.selectOptions(screen.getByLabelText('Type'), 'FINAL');
    await user.selectOptions(screen.getByLabelText('Payment'), 'overdue');
    await waitFor(() => {
      const q = last('/invoices');
      expect(q.get('status')).toBe('ISSUED');
      expect(q.get('invoiceType')).toBe('FINAL');
      expect(q.get('overdue')).toBe('true');
      expect(q.get('unpaid')).toBeNull();
    });
    await user.selectOptions(screen.getByLabelText('Payment'), 'unpaid');
    await waitFor(() => { expect(last('/invoices').get('unpaid')).toBe('true'); expect(last('/invoices').get('overdue')).toBeNull(); });
    await user.type(screen.getByLabelText('Search'), 'INV-2026');
    await waitFor(() => expect(last('/invoices').get('search')).toBe('INV-2026'));
  });

  it('is in the menu and refused without invoices.view', async () => {
    permissions = ['payments.view'];
    mount('/invoices');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('payments page', () => {
  it('lists every payment, linking to the file when it has one', async () => {
    mount('/payments');
    const row = (await screen.findByText('PAY-2026-00001')).closest('tr')!;
    expect(within(row).getByText('Bank transfer')).toBeInTheDocument();
    expect(within(row).getByText('TRX-889')).toBeInTheDocument();
    expect(within(row).getByText('Not fully applied')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open file' })).toHaveAttribute('href', '/files/f1');
    const other = screen.getByText('PAY-2026-00002').closest('tr')!;
    expect(within(other).getByText('Advance')).toBeInTheDocument();
    expect(within(other).queryByRole('link', { name: 'Open file' })).not.toBeInTheDocument();
    expect(within(other).queryByText('Not fully applied')).not.toBeInTheDocument();
  });

  it('sends the filters to the API', async () => {
    mount('/payments');
    const user = userEvent.setup();
    await screen.findByText('PAY-2026-00001');
    await user.selectOptions(screen.getByLabelText('Type'), 'REFUND');
    await user.click(screen.getByLabelText('Not fully applied'));
    await waitFor(() => {
      const q = last('/payments');
      expect(q.get('paymentType')).toBe('REFUND');
      expect(q.get('unallocated')).toBe('true');
    });
  });

  it('is refused without payments.view', async () => {
    permissions = ['invoices.view'];
    mount('/payments');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows both pages in Arabic', async () => {
    setLocale('ar');
    mount('/invoices');
    expect(await screen.findByRole('heading', { name: 'الفواتير' })).toBeInTheDocument();
    expect(await screen.findByText('غير مدفوعة', { selector: 'option' })).toBeInTheDocument();
  });
});
