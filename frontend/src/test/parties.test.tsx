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

const PARTIES = [
  { id: 'p1', name: 'Med Agency', partyType: 'SHIPPING_AGENT', taxNumber: 'TX-77', phone: '+961 1 111111', email: 'ops@med.test', address: 'Beirut port', countryCode: 'LB' },
  { id: 'p2', name: 'FastFreight', partyType: 'FREIGHT_FORWARDER', taxNumber: null, phone: null, email: null, address: null, countryCode: null },
  { id: 'p3', name: 'Cedar Supplies', partyType: 'SUPPLIER', taxNumber: null, phone: null, email: null, address: null, countryCode: 'LB' },
];
const FILE = {
  id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status: 'OPEN', priority: 'NORMAL', openedAt: '2026-11-03T10:00:00.000+00:00', expectedArrivalAt: null, closedAt: null,
  customsReference: null, internalNotes: null, client: { id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading' }, branch: null,
  currentStage: { id: 's1', code: 'NEW_FILE', nameEn: 'New file', nameAr: null, isTerminal: false }, assignee: null, createdBy: null, workflowTemplate: null, shipments: [],
};
const SHIPMENT = {
  id: 'sh1', shipmentType: 'SEA', vesselName: 'MSC Anna', voyageNumber: null, billOfLadingNumber: 'BL-123', masterBlNumber: null, houseBlNumber: null, etd: null, eta: null, actualArrivalAt: null, notes: null,
  originPort: null, destinationPort: null, shippingAgent: { id: 'p1', name: 'Med Agency', partyType: 'SHIPPING_AGENT' }, freightForwarder: null, _count: { containers: 0, goodsItems: 0 },
};

let permissions: string[];
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['clients.view', 'clients.manage', 'clearance_files.view', 'clearance_files.update'];
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const [path, qs = ''] = url.replace('/api/v1', '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const query = new URLSearchParams(qs);
    calls.push({ method, path, query, body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/parties' && method === 'GET') {
      const t = query.get('partyType');
      const rows = t ? PARTIES.filter((p) => p.partyType === t) : PARTIES;
      return ok(rows, { page: 1, limit: 20, total: rows.length });
    }
    if (path === '/clearance-files/f1' && method === 'GET') return ok(FILE);
    if (path === '/clearance-files/f1/shipments' && method === 'GET') return ok([SHIPMENT]);
    if (path === '/shipments/sh1' && method === 'GET') return ok({ ...SHIPMENT, containers: [], goodsItems: [] });
    if (path.endsWith('/transitions')) return ok({ currentStage: null, status: 'OPEN', transitions: [] });
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 1, containers: 0, goodsLines: 0, documents: 0, openTasks: 0 } });
    if (path === '/ports') return ok([], { page: 1, limit: 25, total: 0 });
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mount = (path: string) => render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const last = () => calls.filter((c) => c.path === '/parties' && c.method === 'GET').at(-1)!.query;

describe('parties page', () => {
  it('lists parties with their kind, contact details and tax number; it is in the menu', async () => {
    mount('/parties');
    const row = (await screen.findByText('Med Agency')).closest('tr')!;
    expect(within(row).getByText('Shipping agent')).toBeInTheDocument();
    expect(within(row).getByText('TX-77')).toBeInTheDocument();
    expect(within(row).getByText('ops@med.test')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Business parties' })).toHaveAttribute('href', '/parties');
  });

  it('filters by kind and searches', async () => {
    mount('/parties');
    const user = userEvent.setup();
    await screen.findByText('Med Agency');
    await user.selectOptions(screen.getByLabelText('Type'), 'SUPPLIER');
    await waitFor(() => expect(last().get('partyType')).toBe('SUPPLIER'));
    await user.type(screen.getByLabelText('Search'), 'cedar');
    await waitFor(() => expect(last().get('search')).toBe('cedar'));
  });

  it('adds a party: needs a name, validates e-mail and country, sends only what was filled in', async () => {
    mount('/parties');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add party' }));
    const form = (await screen.findByRole('heading', { name: 'Add party', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Enter a name')).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Name'), 'Gulf Transport');
    await user.type(within(form).getByLabelText('Email'), 'nope');
    await user.type(within(form).getByLabelText('Country'), 'x');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Enter a valid email address')).toBeInTheDocument();
    expect(sent('POST', '/parties')).toHaveLength(0);
    await user.clear(within(form).getByLabelText('Email'));
    await user.clear(within(form).getByLabelText('Country'));
    await user.selectOptions(within(form).getByLabelText('Type'), 'TRANSPORTER');
    await user.type(within(form).getByLabelText('Country'), 'ae');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/parties')).toHaveLength(1));
    expect(sent('POST', '/parties')[0].body).toEqual({ name: 'Gulf Transport', partyType: 'TRANSPORTER', taxNumber: '', phone: '', address: '', countryCode: 'AE' });
  });

  it('edits a party, clearing fields that were emptied', async () => {
    mount('/parties');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit Med Agency' }));
    const form = (await screen.findByRole('heading', { name: 'Edit party', level: 2 })).closest('form')!;
    await user.clear(within(form).getByLabelText('Email'));
    await user.clear(within(form).getByLabelText('Country'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/parties/p1')).toHaveLength(1));
    expect(sent('PATCH', '/parties/p1')[0].body).toEqual({ name: 'Med Agency', partyType: 'SHIPPING_AGENT', taxNumber: 'TX-77', phone: '+961 1 111111', address: 'Beirut port', email: null, countryCode: null });
  });

  it('shows the server refusal', async () => {
    failNext['POST /parties'] = fail(422, 'VALIDATION_ERROR', 'Request validation failed');
    mount('/parties');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add party' }));
    await user.type(await screen.findByLabelText('Name'), 'X');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Request validation failed')).toBeInTheDocument();
  });

  it('is view-only without clients.manage, and refused without clients.view', async () => {
    permissions = ['clients.view'];
    mount('/parties');
    await screen.findByText('Med Agency');
    expect(screen.queryByRole('button', { name: 'Add party' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit/ })).not.toBeInTheDocument();
  });

  it('is refused without clients.view', async () => {
    permissions = ['tasks.view'];
    mount('/parties');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('shipment form: agent and forwarder', () => {
  const openForm = async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Shipments' }));
    await user.click(await screen.findByRole('button', { name: 'Add shipment' }));
    return user;
  };

  it('picks an agent and a forwarder of the right kind', async () => {
    const user = await openForm();
    const agent = await screen.findByLabelText('Shipping agent', { selector: 'select' });
    const forwarder = screen.getByLabelText('Freight forwarder', { selector: 'select' });
    await waitFor(() => expect(within(agent).getByRole('option', { name: 'Med Agency' })).toBeInTheDocument());
    await waitFor(() => expect(within(forwarder).getByRole('option', { name: 'FastFreight' })).toBeInTheDocument());
    expect(within(agent).queryByRole('option', { name: 'FastFreight' })).not.toBeInTheDocument();
    expect(calls.some((c) => c.path === '/parties' && c.query.get('partyType') === 'SHIPPING_AGENT')).toBe(true);
    await user.selectOptions(agent, 'p1');
    await user.selectOptions(forwarder, 'p2');
    await user.type(screen.getByLabelText('Bill of lading'), 'BL-9');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/clearance-files/f1/shipments')).toHaveLength(1));
    expect(sent('POST', '/clearance-files/f1/shipments')[0].body).toMatchObject({ billOfLadingNumber: 'BL-9', shippingAgentId: 'p1', freightForwarderId: 'p2' });
  });

  it('editing keeps the saved agent selected and can clear it', async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Shipments' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const agent = await screen.findByLabelText('Shipping agent', { selector: 'select' });
    await waitFor(() => expect(agent).toHaveValue('p1'));
    await user.selectOptions(agent, '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/shipments/sh1')).toHaveLength(1));
    expect(sent('PATCH', '/shipments/sh1')[0].body).toMatchObject({ shippingAgentId: null, freightForwarderId: null });
  });

  it('without clients.view the pickers are hidden and the saved agent is left alone', async () => {
    permissions = ['clearance_files.view', 'clearance_files.update'];
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Shipments' }));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('Bill of lading');
    expect(screen.queryByLabelText('Shipping agent', { selector: 'select' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/shipments/sh1')).toHaveLength(1));
    expect(sent('PATCH', '/shipments/sh1')[0].body).not.toHaveProperty('shippingAgentId');
    expect(calls.some((c) => c.path === '/parties')).toBe(false);
  });
});

describe('Arabic', () => {
  it('shows the page in Arabic', async () => {
    setLocale('ar');
    mount('/parties');
    expect(await screen.findByRole('heading', { name: 'الجهات التجارية', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('وكيل ملاحي', { selector: 'span' })).toBeInTheDocument();
  });
});
