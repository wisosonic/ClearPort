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
const fail = (status: number, code: string, message: string) => res(status, { success: false, error: { code, message, details: [] } });

const FILE = (status = 'OPEN') => ({
  id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status, priority: 'NORMAL', openedAt: '2026-11-03T10:00:00.000+00:00', expectedArrivalAt: null, closedAt: null,
  customsReference: null, internalNotes: null, client: { id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading' }, branch: null,
  currentStage: { id: 's1', code: 'NEW_FILE', nameEn: 'New file', nameAr: null, isTerminal: false }, assignee: null, createdBy: null, workflowTemplate: null,
  shipments: [],
});
const SHIPMENT = {
  id: 'sh1', shipmentType: 'SEA', vesselName: 'MSC Anna', voyageNumber: 'V12', billOfLadingNumber: 'BL-123', masterBlNumber: null, houseBlNumber: null,
  etd: null, eta: '2026-11-20T00:00:00.000+00:00', actualArrivalAt: null, notes: null,
  originPort: { id: 'p1', code: 'CNSHA', name: 'Shanghai', countryCode: 'CN' }, destinationPort: { id: 'p2', code: 'LBBEY', name: 'Beirut', countryCode: 'LB' },
  shippingAgent: null, freightForwarder: null, _count: { containers: 1, goodsItems: 1 },
};
const DETAIL = () => ({
  ...SHIPMENT,
  containers: [{ id: 'ct1', containerNumber: 'CSQU3054383', containerType: '40HC', sealNumber: 'S1', grossWeight: '20000.000', netWeight: null, packageCount: 10, status: 'AT_PORT' }],
  goodsItems: [{ id: 'g1', description: 'Cotton fabric', countryOfOrigin: 'TR', quantity: '100.0000', unitOfMeasure: 'm', grossWeight: null, netWeight: null, unitPrice: '2.5000', lineTotal: '250.0000', currencyCode: 'USD', hsCode: null }],
});

let permissions: string[];
let fileStatus: string;
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['clearance_files.view', 'clearance_files.update'];
  fileStatus = 'OPEN';
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
    if (path === '/clearance-files/f1/shipments' && method === 'GET') return ok([SHIPMENT]);
    if (path === '/shipments/sh1' && method === 'GET') return ok(DETAIL());
    if (path.endsWith('/transitions')) return ok({ currentStage: null, status: fileStatus, transitions: [] });
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 1, containers: 1, goodsLines: 1, documents: 0, openTasks: 0 } });
    if (path === '/ports') return ok([{ id: 'p1', code: 'CNSHA', name: 'Shanghai', countryCode: 'CN' }, { id: 'p2', code: 'LBBEY', name: 'Beirut', countryCode: 'LB' }], { page: 1, limit: 25, total: 2 });
    if (path === '/currencies') return ok([{ code: 'USD' }, { code: 'LBP' }, { code: 'EUR' }]);
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'new' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async () => {
  render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Shipments' }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('shipments tab', () => {
  it('shows the shipment with its containers and goods, money with its currency', async () => {
    await open();
    expect(await screen.findByText('CSQU3054383')).toBeInTheDocument();
    expect(screen.getByText('BL-123')).toBeInTheDocument();
    expect(screen.getByText('Shanghai (CNSHA)')).toBeInTheDocument();
    expect(screen.getByText('Cotton fabric')).toBeInTheDocument();
    expect(screen.getByText('250.00 USD')).toBeInTheDocument();
    expect(screen.getByText('At port')).toBeInTheDocument();
  });

  it('offers no changes on a closed file, and says why', async () => {
    fileStatus = 'CLOSED';
    await open();
    await screen.findByText('CSQU3054383');
    expect(screen.getByText(/closed or cancelled/)).toBeInTheDocument();
    for (const name of ['Add shipment', 'Add container', 'Add goods line', 'Edit']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('offers no changes without the update permission', async () => {
    permissions = ['clearance_files.view'];
    await open();
    await screen.findByText('CSQU3054383');
    expect(screen.queryByRole('button', { name: 'Add container' })).not.toBeInTheDocument();
  });

  it('adds a shipment and sends only what was filled in', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add shipment' }));
    await user.selectOptions(screen.getByLabelText('Shipment type'), 'AIR');
    await user.type(screen.getByLabelText('Bill of lading'), 'AWB-9');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/clearance-files/f1/shipments')).toHaveLength(1));
    expect(sent('POST', '/clearance-files/f1/shipments')[0].body).toEqual({ shipmentType: 'AIR', billOfLadingNumber: 'AWB-9' });
  });

  it('adds a container; a non-ISO number needs an explicit confirmation', async () => {
    failNext['POST /shipments/sh1/containers'] = fail(422, 'CONTAINER_NUMBER_NOT_ISO6346', '"ABC123" is not an ISO 6346 container number');
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add container' }));
    await user.type(screen.getByLabelText('Container no.'), 'ABC123');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('is not an ISO 6346 container number');

    await user.click(screen.getByLabelText(/Record this number even though/));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/shipments/sh1/containers')).toHaveLength(2));
    expect(sent('POST', '/shipments/sh1/containers')[0].body).toMatchObject({ containerNumber: 'ABC123', nonStandardNumber: false, status: 'PLANNED' });
    expect(sent('POST', '/shipments/sh1/containers')[1].body).toMatchObject({ containerNumber: 'ABC123', nonStandardNumber: true });
  });

  it('rejects a weight that is not a number before asking the server', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add container' }));
    await user.type(screen.getByLabelText('Container no.'), 'CSQU3054383');
    await user.type(screen.getByLabelText('Gross weight'), '12,5kg');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a number such as 12.5')).toBeInTheDocument();
    expect(sent('POST', '/shipments/sh1/containers')).toHaveLength(0);
  });

  it('changes a container status', async () => {
    const user = await open();
    const row = (await screen.findByText('CSQU3054383')).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Edit' }));
    await user.selectOptions(screen.getByLabelText('Status'), 'RELEASED');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/containers/ct1')).toHaveLength(1));
    expect(sent('PATCH', '/containers/ct1')[0].body).toMatchObject({ status: 'RELEASED', packageCount: 10, netWeight: null });
    expect(sent('PATCH', '/containers/ct1')[0].body).not.toHaveProperty('containerNumber'); // unchanged, so not re-validated
  });

  it('adds goods: asks for a description, lets the server compute the total, and needs a currency for prices', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Add goods line' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Describe the goods')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Description'), 'Steel pipes');
    await user.type(screen.getByLabelText('Quantity'), '10');
    await user.type(screen.getByLabelText('Unit price'), '3.5');
    expect(screen.getByLabelText('Line total')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose a currency for the price')).toBeInTheDocument();
    expect(sent('POST', '/shipments/sh1/goods')).toHaveLength(0);

    await user.selectOptions(screen.getByLabelText('Currency'), 'USD');
    await user.type(screen.getByLabelText('Origin'), 'tr');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/shipments/sh1/goods')).toHaveLength(1));
    expect(sent('POST', '/shipments/sh1/goods')[0].body).toEqual({ description: 'Steel pipes', countryOfOrigin: 'TR', quantity: '10', unitPrice: '3.5', currencyCode: 'USD' });
  });

  it('works in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'الشحنات' }));
    expect(await screen.findByText('CSQU3054383')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByText('في الميناء')).toBeInTheDocument();
  });
});
