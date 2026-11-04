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
const text = (en: string, ar: string, key: string, type = 'text') => ({ key, header: { en, ar }, type });

const TABLES: Record<string, { rows: unknown[]; meta: Record<string, unknown> }> = {
  'clearance-files': {
    rows: [{ fileNumber: 'IMP-2026-00001', status: 'OPEN', client: 'Al Nour', stage: 'Customs', stageAr: 'الجمارك', openedAt: '2026-11-04', daysOpen: 3 }],
    meta: {
      title: { en: 'Clearance files', ar: 'ملفات التخليص' }, totals: { fileNumber: 1 },
      columns: [text('File number', 'رقم الملف', 'fileNumber'), text('Status', 'الحالة', 'status'), text('Client', 'العميل', 'client'), text('Stage', 'المرحلة', 'stage'), text('Opened', 'تاريخ الفتح', 'openedAt', 'date'), text('Days open', 'الأيام', 'daysOpen', 'int')],
    },
  },
  'client-balances': {
    rows: [
      { clientCode: 'CLT-1', client: 'Al Nour', currency: 'USD', outstanding: '290.0000' },
      { clientCode: 'CLT-1', client: 'Al Nour', currency: 'LBP', outstanding: '9000000.0000' },
    ],
    meta: {
      title: { en: 'Client balances', ar: 'أرصدة العملاء' }, totals: null, totalsByCurrency: { outstanding: { USD: '290.0000', LBP: '9000000.0000' } },
      columns: [text('Code', 'الرمز', 'clientCode'), text('Client', 'العميل', 'client'), text('Currency', 'العملة', 'currency'), text('Outstanding', 'المستحق', 'outstanding', 'money')],
    },
  },
  expenses: {
    rows: [{ date: '2026-11-04', description: 'Port fee', amount: '120.0000', currency: 'USD', baseAmount: '120.0000', status: 'APPROVED' }],
    meta: {
      title: { en: 'Expenses', ar: 'المصاريف' }, baseCurrency: 'USD', totals: { baseAmount: '120.0000', description: '1' },
      columns: [text('Date', 'التاريخ', 'date', 'date'), text('Description', 'البيان', 'description'), text('Amount', 'المبلغ', 'amount', 'money'), text('Amount (USD)', 'المبلغ (USD)', 'baseAmount', 'money'), text('Status', 'الحالة', 'status')],
    },
  },
  revenue: {
    rows: [{ group: '2026-11', revenue: '290.0000' }],
    meta: {
      title: { en: 'Revenue', ar: 'الإيرادات' }, baseCurrency: 'USD', note: 'Revenue is service fees only.', totals: { group: '', revenue: '290.0000' },
      columns: [text('Month', 'الشهر', 'group'), text('Service revenue (USD)', 'إيرادات الخدمات (USD)', 'revenue', 'money')],
    },
  },
  'employee-performance': {
    rows: [{ employee: 'Layla Haddad', filesAssignedOpen: 1 }],
    meta: { title: { en: 'Employee performance', ar: 'أداء الموظفين' }, baseCurrency: 'USD', totals: null, columns: [text('Employee', 'الموظف', 'employee'), text('Open files', 'ملفات مفتوحة', 'filesAssignedOpen', 'int')] },
  },
};
const ALL = ['reports.view', 'reports.export', 'clearance_files.view', 'invoices.view', 'payments.view', 'expenses.view', 'users.manage'];
let permissions: string[];
let calls: { path: string; query: URLSearchParams }[];
let exportFail: boolean;

beforeEach(() => {
  permissions = [...ALL];
  calls = [];
  exportFail = false;
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
    if (path === '/reports/export') {
      if (exportFail) return res(403, { success: false, error: { code: 'PERMISSION_DENIED', message: 'You do not have permission to export this report', details: [] } });
      return new Response(new Blob(['xlsx-bytes']), { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="revenue-20261104.xlsx"' } });
    }
    const t = TABLES[path.replace('/reports/', '')];
    if (t) return ok(t.rows, { page: 1, limit: 20, total: t.rows.length, report: path, ...t.meta });
    return res(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route', details: [] } });
  }));
});

const mount = () => render(<App router={createTestRouter('/reports') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const last = (path: string) => calls.filter((c) => c.path === path).at(-1)!.query;

describe('reports page', () => {
  it('shows the first report as a table with a total, translated values and dates', async () => {
    mount();
    expect(await screen.findByRole('heading', { name: 'Clearance files', level: 2 })).toBeInTheDocument();
    const row = (await screen.findByText('IMP-2026-00001')).closest('tr')!;
    expect(within(row).getByText('Open')).toBeInTheDocument(); // OPEN translated
    expect(within(row).getByText('4 Nov 2026')).toBeInTheDocument();
    expect(within(row).getByText('Customs')).toBeInTheDocument();
    expect(screen.getByText('Total (1)')).toBeInTheDocument();
  });

  it('offers only the reports the user may open', async () => {
    permissions = ['reports.view', 'expenses.view'];
    mount();
    const pick = await screen.findByLabelText('Report');
    expect(within(pick).getAllByRole('option').map((o) => o.textContent)).toEqual(['Expenses', 'Revenue']);
  });

  it('is refused without reports.view', async () => {
    permissions = ['clearance_files.view'];
    mount();
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });

  it('shows money in each row\'s own currency, never summed, with totals per currency', async () => {
    mount();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Report'), 'client-balances');
    const usd = (await screen.findByText('290.00 USD', { selector: 'td' })).closest('tr')!;
    expect(within(usd).getByText('USD')).toBeInTheDocument();
    expect(screen.getByText('9,000,000 LBP', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText('Totals by currency')).toBeInTheDocument();
    expect(screen.getByText(/290.00 USD · 9,000,000 LBP/)).toBeInTheDocument();
    expect(last('/reports/client-balances').get('onlyOpen')).toBe('true');
    await user.click(screen.getByLabelText('Only with a balance'));
    await waitFor(() => expect(last('/reports/client-balances').get('onlyOpen')).toBe('false'));
  });

  it('base-currency reports show plain amounts under a header that names the currency', async () => {
    mount();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Report'), 'expenses');
    const row = (await screen.findByText('Port fee')).closest('tr')!;
    expect(within(row).getByText('120.00 USD')).toBeInTheDocument(); // transaction amount with its own currency
    expect(within(row).getByText('120.00')).toBeInTheDocument(); // base amount: header says (USD)
    expect(within(row).getByText('Approved')).toBeInTheDocument(); // expense statuses, not file statuses
    expect(screen.getByRole('columnheader', { name: 'Amount (USD)' })).toBeInTheDocument();
  });

  it('revenue can be grouped by month or client, and filtered by dates', async () => {
    mount();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Report'), 'revenue');
    expect(await screen.findByText('Revenue is service fees only.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Group by'), 'client');
    await waitFor(() => expect(last('/reports/revenue').get('groupBy')).toBe('client'));
    await user.type(screen.getByLabelText('From'), '2026-11-01');
    await waitFor(() => expect(last('/reports/revenue').get('from')).toBe('2026-11-01'));
  });

  it('searches the reports that support it', async () => {
    mount();
    const user = userEvent.setup();
    await screen.findByText('IMP-2026-00001');
    await user.type(screen.getByLabelText('Search'), 'IMP-2026');
    await waitFor(() => expect(last('/reports/clearance-files').get('search')).toBe('IMP-2026'));
    await user.selectOptions(screen.getByLabelText('Report'), 'revenue');
    await screen.findByText('2026-11');
    expect(screen.queryByLabelText('Search')).not.toBeInTheDocument();
  });
});

describe('exporting', () => {
  it('downloads the current report with the filters, in the interface language', async () => {
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
    (URL as any).createObjectURL = vi.fn(() => 'blob:x');
    (URL as any).revokeObjectURL = vi.fn();
    mount();
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Report'), 'revenue');
    await screen.findByText('2026-11');
    await user.click(screen.getByRole('button', { name: 'Excel' }));
    await waitFor(() => expect(saved).toEqual(['revenue-20261104.xlsx']));
    const q = last('/reports/export');
    expect(q.get('report')).toBe('revenue');
    expect(q.get('format')).toBe('xlsx');
    expect(q.get('locale')).toBe('en');
    expect(q.get('groupBy')).toBe('month');
  });

  it('shows the server message when an export is refused', async () => {
    exportFail = true;
    mount();
    const user = userEvent.setup();
    await screen.findByText('IMP-2026-00001');
    await user.click(screen.getByRole('button', { name: 'PDF' }));
    expect(await screen.findByText(/do not have permission to export/)).toBeInTheDocument();
  });

  it('has no export buttons without reports.export', async () => {
    permissions = permissions.filter((p) => p !== 'reports.export');
    mount();
    await screen.findByText('IMP-2026-00001');
    expect(screen.queryByRole('button', { name: 'Excel' })).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the report titles and column headers in Arabic, with the Arabic stage name', async () => {
    setLocale('ar');
    mount();
    expect(await screen.findByRole('heading', { name: 'ملفات التخليص', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'رقم الملف' })).toBeInTheDocument();
    expect(await screen.findByText('الجمارك')).toBeInTheDocument();
  });
});
