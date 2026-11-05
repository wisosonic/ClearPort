import { render, screen, within } from '@testing-library/react';
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

const FILE = {
  id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status: 'OPEN', priority: 'NORMAL', openedAt: '2026-11-03T10:00:00.000+00:00', expectedArrivalAt: null, closedAt: null,
  customsReference: null, internalNotes: null, client: { id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading' }, branch: null,
  currentStage: { id: 's1', code: 'NEW_FILE', nameEn: 'New file', nameAr: null, isTerminal: false }, assignee: null, createdBy: null, workflowTemplate: null, shipments: [],
};
const COSTS = {
  file: { id: 'f1', fileNumber: 'IMP-2026-00001', status: 'OPEN', client: { id: 'c1', name: 'Al Nour Trading' } }, baseCurrency: 'USD', basis: 'BASE_CURRENCY',
  profitability: { serviceRevenue: '500.0000', officeCosts: '120.0000', profit: '380.0000', marginPercent: '76.00', note: 'x' },
  passThrough: { disbursed: '200.0000', reBilled: '120.0000', unrecovered: '80.0000', unbilledExpenses: [{ id: 'x1', description: 'Storage fee', amount: '80.0000', currencyCode: 'USD', baseAmount: '80.0000' }] },
  taxCollected: '0.0000', fxGainLoss: '0.0000', receivables: { outstandingBase: '300.0000' },
  invoices: { count: 2, invoicedByCurrency: { USD: '620.0000', LBP: '89500000.0000' }, paidByCurrency: { USD: '320.0000' }, outstandingByCurrency: { USD: '300.0000', LBP: '89500000.0000' }, items: [] },
};
let permissions: string[];

beforeEach(() => {
  permissions = ['clearance_files.view', 'reports.view'];
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.replace('/api/v1', '').split('?')[0];
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/clearance-files/f1') return ok(FILE);
    if (path === '/clearance-files/f1/costs') return ok(COSTS);
    if (path.endsWith('/transitions')) return ok({ currentStage: null, status: 'OPEN', transitions: [] });
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 0, containers: 0, goodsLines: 0, documents: 0, openTasks: 0 } });
    return res(404, { success: false, error: { code: 'NOT_FOUND', message: 'no route', details: [] } });
  }));
});

const mount = () => render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);

describe('costs and profit tab', () => {
  it('shows profit, pass-through money apart from it, and invoicing per currency', async () => {
    mount();
    await userEvent.setup().click(await screen.findByRole('tab', { name: 'Costs and profit' }));
    expect(await screen.findByText('Service revenue')).toBeInTheDocument();
    const profit = screen.getByText('Profit', { selector: 'dt' }).closest('div')!;
    expect(within(profit).getByText('380.00 USD')).toBeInTheDocument();
    expect(screen.getByText('76%')).toBeInTheDocument();
    expect(screen.getByText('Not yet recovered').closest('div')).toHaveTextContent('80.00 USD');
    expect(screen.getByText('620.00 USD · 89,500,000 LBP')).toBeInTheDocument(); // never added together
    expect(screen.getByText('Storage fee')).toBeInTheDocument(); // paid out, not yet on an invoice
  });

  it('has no costs tab without reports.view', async () => {
    permissions = ['clearance_files.view'];
    mount();
    await screen.findByRole('tab', { name: 'Overview' });
    expect(screen.queryByRole('tab', { name: 'Costs and profit' })).not.toBeInTheDocument();
  });
});
