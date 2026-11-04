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

const FILEREF = { id: 'f1', fileNumber: 'IMP-2026-00001', status: 'OPEN', client: { id: 'c1', name: 'Al Nour Trading' } };
const SHIPMENTS = [
  { id: 's1', shipmentType: 'SEA', vesselName: 'MSC Aurora', voyageNumber: 'V123', billOfLadingNumber: 'BL-777', masterBlNumber: null, houseBlNumber: null, eta: '2026-11-20T08:00:00.000Z', actualArrivalAt: null, originPort: { code: 'CNSHA' }, destinationPort: { code: 'LBBEY' }, _count: { containers: 2, goodsItems: 1 }, clearanceFile: FILEREF },
  { id: 's2', shipmentType: 'AIR', vesselName: null, voyageNumber: null, billOfLadingNumber: null, masterBlNumber: 'MBL-9', houseBlNumber: null, eta: null, actualArrivalAt: '2026-11-02T00:00:00.000Z', originPort: null, destinationPort: null, _count: { containers: 0, goodsItems: 0 }, clearanceFile: FILEREF },
];
const T_INV = { id: 'dt1', code: 'COMMERCIAL_INVOICE', nameEn: 'Commercial invoice', nameAr: 'فاتورة تجارية', isActive: true };
const DOCS = [
  { id: 'd1', documentType: T_INV, originalFilename: 'فاتورة-123.pdf', fileSize: 1_500_000, versionNumber: 2, status: 'PENDING_REVIEW', uploadedBy: { id: 'u1', firstName: 'Sara', lastName: 'Khoury' }, uploadedAt: '2026-11-03T10:00:00.000Z', clearanceFile: { id: 'f1', fileNumber: 'IMP-2026-00001' } },
  { id: 'd2', documentType: T_INV, originalFilename: 'old.pdf', fileSize: 1000, versionNumber: 1, status: 'VOID', uploadedBy: null, uploadedAt: '2026-10-01T10:00:00.000Z', clearanceFile: { id: 'f1', fileNumber: 'IMP-2026-00001' } },
];
const EXPENSES = [
  { id: 'x1', description: 'Port fee 40ft', amount: '120.0000', currencyCode: 'USD', expenseDate: '2026-11-03T12:00:00.000Z', status: 'APPROVED', paymentStatus: 'PAID', category: { id: 'cat2', name: 'Port fees' }, clearanceFile: { id: 'f1', fileNumber: 'IMP-2026-00001' }, isBilled: true, billedOn: { id: 'i1', invoiceNumber: 'INV-2026-00001', status: 'ISSUED' } },
  { id: 'x2', description: 'Rent', amount: '9000000.0000', currencyCode: 'LBP', expenseDate: '2026-11-01T12:00:00.000Z', status: 'DRAFT', paymentStatus: 'UNPAID', category: { id: 'cat3', name: 'Office expenses' }, clearanceFile: null, isBilled: false, billedOn: null },
];
const CATS = [
  { id: 'cat1', name: 'Clearance service fees', costTreatment: 'OFFICE_REVENUE', isBillableToClient: true, isActive: true },
  { id: 'cat2', name: 'Port fees', costTreatment: 'PASS_THROUGH', isBillableToClient: true, isActive: true },
];

let permissions: string[];
let calls: { path: string; query: URLSearchParams }[];

beforeEach(() => {
  permissions = ['clearance_files.view', 'documents.view', 'expenses.view'];
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
    if (path === '/shipments') return ok(SHIPMENTS, { page: 1, limit: 20, total: 2 });
    if (path === '/documents') return ok(DOCS, { page: 1, limit: 20, total: 2 });
    if (path === '/document-types') return ok([T_INV]);
    if (path === '/expenses') return ok(EXPENSES, { page: 1, limit: 20, total: 2 });
    if (path === '/financial-categories') return ok(CATS);
    if (path === '/documents/d1/download') return new Response(new Blob(['%PDF']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('فاتورة-123.pdf')}` } });
    return res(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route', details: [] } });
  }));
});

const mount = (path: string) => render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const last = (path: string) => calls.filter((c) => c.path === path).at(-1)!.query;

describe('shipments page', () => {
  it('lists shipments with file link, client, BL, vessel, route, ETA and containers', async () => {
    mount('/shipments');
    const row = (await screen.findByText('BL-777')).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'IMP-2026-00001' })).toHaveAttribute('href', '/files/f1');
    expect(within(row).getByText('Al Nour Trading')).toBeInTheDocument();
    expect(within(row).getByText('MSC Aurora')).toBeInTheDocument();
    expect(within(row).getByText('CNSHA → LBBEY')).toBeInTheDocument();
    expect(within(row).getByText('20 Nov 2026')).toBeInTheDocument();
    expect(within(row).getByText('Sea')).toBeInTheDocument();
    const air = screen.getByText('MBL-9').closest('tr')!; // falls back to the master BL
    expect(within(air).getByText('Arrived')).toBeInTheDocument();
    expect(within(air).getByText('Air')).toBeInTheDocument();
  });

  it('sends the filters, sorted by ETA', async () => {
    mount('/shipments');
    const user = userEvent.setup();
    await screen.findByText('BL-777');
    expect(last('/shipments').get('sort')).toBe('eta:asc');
    await user.selectOptions(screen.getByLabelText('Shipment type'), 'AIR');
    await user.selectOptions(screen.getByLabelText('Arrival'), 'false');
    await user.type(screen.getByLabelText('Search'), 'MSKU');
    await waitFor(() => {
      const q = last('/shipments');
      expect(q.get('shipmentType')).toBe('AIR'); expect(q.get('arrived')).toBe('false'); expect(q.get('search')).toBe('MSKU');
    });
    await user.type(screen.getByLabelText('ETA From'), '2026-11-01');
    await waitFor(() => expect(last('/shipments').get('from')).toBe('2026-11-01'));
  });

  it('is refused without clearance_files.view', async () => {
    permissions = ['tasks.view'];
    mount('/shipments');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('documents page', () => {
  it('lists documents with type, version, size, status and file link; voided ones are dimmed and cannot be downloaded', async () => {
    mount('/documents');
    const row = (await screen.findByText('فاتورة-123.pdf')).closest('tr')!;
    expect(within(row).getByText('Commercial invoice')).toBeInTheDocument();
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(within(row).getByText('1.4 MB')).toBeInTheDocument();
    expect(within(row).getByText('Pending review')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'IMP-2026-00001' })).toHaveAttribute('href', '/files/f1');
    const voided = screen.getByText('old.pdf').closest('tr')!;
    expect(within(voided).getByText('Void')).toBeInTheDocument();
    expect(within(voided).queryByRole('button', { name: /Download/ })).not.toBeInTheDocument();
  });

  it('downloads with the real file name', async () => {
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    (URL as any).createObjectURL = vi.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = vi.fn();
    mount('/documents');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Download فاتورة-123.pdf/ }));
    await waitFor(() => expect(saved).toEqual(['فاتورة-123.pdf']));
  });

  it('sends the filters; voided documents are only included on request', async () => {
    mount('/documents');
    const user = userEvent.setup();
    await screen.findByText('old.pdf');
    expect(last('/documents').get('includeVoid')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Status'), 'APPROVED');
    await user.click(screen.getByLabelText('Include voided'));
    await waitFor(() => { expect(last('/documents').get('status')).toBe('APPROVED'); expect(last('/documents').get('includeVoid')).toBe('true'); });
    await waitFor(() => expect(within(screen.getByLabelText('Document type')).getByRole('option', { name: 'Commercial invoice' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Document type'), 'dt1');
    await waitFor(() => expect(last('/documents').get('documentTypeId')).toBe('dt1'));
  });

  it('is refused without documents.view', async () => {
    permissions = ['clearance_files.view'];
    mount('/documents');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('expenses page', () => {
  it('lists expenses with file link, category, amount in its own currency and state', async () => {
    mount('/expenses');
    const row = (await screen.findByText('Port fee 40ft')).closest('tr')!;
    expect(within(row).getByRole('link', { name: 'IMP-2026-00001' })).toHaveAttribute('href', '/files/f1');
    expect(within(row).getByText('Port fees')).toBeInTheDocument();
    expect(within(row).getByText('120.00 USD')).toBeInTheDocument();
    expect(within(row).getByText('Approved')).toBeInTheDocument();
    expect(within(row).getByText('Paid')).toBeInTheDocument();
    expect(within(row).getByText('On INV-2026-00001')).toBeInTheDocument();
    const rent = screen.getByText('Rent').closest('tr')!;
    expect(within(rent).getByText('9,000,000 LBP')).toBeInTheDocument();
    expect(within(rent).getByText('Draft')).toBeInTheDocument();
  });

  it('sends the filters, offering only cost categories', async () => {
    mount('/expenses');
    const user = userEvent.setup();
    await screen.findByText('Port fee 40ft');
    const cat = screen.getByLabelText('Category');
    await waitFor(() => expect(within(cat).getByRole('option', { name: 'Port fees' })).toBeInTheDocument());
    expect(within(cat).queryByRole('option', { name: 'Clearance service fees' })).not.toBeInTheDocument();
    await user.selectOptions(cat, 'cat2');
    await user.selectOptions(screen.getByLabelText('Status'), 'APPROVED');
    await user.selectOptions(screen.getByLabelText('Payment'), 'UNPAID');
    await user.selectOptions(screen.getByLabelText('Re-billing'), 'false');
    await waitFor(() => {
      const q = last('/expenses');
      expect(q.get('categoryId')).toBe('cat2'); expect(q.get('status')).toBe('APPROVED'); expect(q.get('paymentStatus')).toBe('UNPAID'); expect(q.get('billed')).toBe('false');
    });
  });

  it('is refused without expenses.view', async () => {
    permissions = ['clearance_files.view'];
    mount('/expenses');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the pages in Arabic', async () => {
    setLocale('ar');
    mount('/shipments');
    expect(await screen.findByRole('heading', { name: 'الشحنات' })).toBeInTheDocument();
    expect(await screen.findByText('بحري')).toBeInTheDocument();
  });
});
