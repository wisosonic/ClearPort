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
const fail = (status: number, code: string, message: string, details: unknown[] = []) => res(status, { success: false, error: { code, message, details } });

const STAGE = (code: string, nameEn: string, isTerminal = false) => ({ id: `s-${code}`, code, nameEn, nameAr: null, isTerminal });
const FILE = (over: Record<string, unknown> = {}) => ({
  id: 'f1', fileNumber: 'IMP-2026-00001', fileType: 'IMPORT', status: 'OPEN', priority: 'NORMAL',
  openedAt: '2026-11-03T10:00:00.000+00:00', expectedArrivalAt: '2026-11-20T00:00:00.000+00:00', closedAt: null,
  customsReference: 'CR-77', internalNotes: 'Handle with care',
  client: { id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading' }, branch: null,
  currentStage: STAGE('DOCUMENT_COLLECTION', 'Document collection'), assignee: null,
  createdBy: { firstName: 'Sara', lastName: 'Khoury' }, workflowTemplate: { id: 'w1', name: 'Import workflow' },
  shipments: [{ id: 'sh1', shipmentType: 'SEA', vesselName: 'MSC Anna', voyageNumber: null, billOfLadingNumber: 'BL123', eta: null, _count: { containers: 2, goodsItems: 3 } }],
  ...over,
});

const ALL = ['clients.view', 'clearance_files.view', 'clearance_files.create', 'clearance_files.update', 'clearance_files.assign', 'clearance_files.close'];
let permissions: string[];
let file: Record<string, any>;
let transitions: unknown[];
let closure: { canClose: boolean; blockers: unknown[]; warnings: unknown[] };
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...ALL];
  file = FILE();
  transitions = [{ transitionId: 't1', toStage: STAGE('CUSTOMS_DECLARATION', 'Customs declaration'), requiresReason: false, allowed: true, blockers: [] }];
  closure = { canClose: true, blockers: [], warnings: [] };
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
    if (path === '/auth/refresh') return ok({ accessToken: 'A2', refreshToken: 'R2'.repeat(20) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'sara@office.test', firstName: 'Sara', lastName: 'Khoury' },
      tenant: { id: 't1', slug: 'beirut', name: 'Beirut Clearance', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/clients') return ok([{ id: 'c1', clientCode: 'CLT-00001', name: 'Al Nour Trading', clientType: 'COMPANY', isActive: true }], { page: 1, limit: 25, total: 1 });
    if (path === '/branches') return ok([{ id: 'b1', code: 'BEY', name: 'Beirut HQ', isActive: true }]);
    if (path === '/clearance-files' && method === 'GET') return ok([], { page: 1, limit: 20, total: 0 });
    if (path === '/clearance-files' && method === 'POST') return ok({ ...FILE({ id: 'f9', fileNumber: 'IMP-2026-00009' }) });
    if (path === '/clearance-files/f404') return fail(404, 'CLEARANCE_FILE_NOT_FOUND', 'Clearance file not found');
    if (path === '/clearance-files/f1' && method === 'GET') return ok(file);
    if (path === '/clearance-files/f9') return ok(FILE({ id: 'f9', fileNumber: 'IMP-2026-00009' }));
    if (path === '/clearance-files/f1' && method === 'PATCH') { file = { ...file, ...body, priority: body.priority }; return ok(file); }
    if (path.endsWith('/transitions')) return ok({ currentStage: file.currentStage, status: file.status, transitions });
    if (path.endsWith('/closure-check')) return ok(closure);
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 1, containers: 2, goodsLines: 3, documents: 4, openTasks: 5 } });
    if (path.endsWith('/timeline')) return ok([{ id: 'a1', activityType: 'FILE_CREATED', description: 'File IMP-2026-00001 created for Al Nour Trading', createdAt: '2026-11-03T10:00:00.000+00:00', user: { firstName: 'Sara', lastName: 'Khoury' } }], { page: 1, limit: 30, total: 1 });
    if (path.endsWith('/status-history')) return ok([{ id: 'h1', fromStage: null, toStage: STAGE('DOCUMENT_COLLECTION', 'Document collection'), reason: 'File created', changedAt: '2026-11-03T10:00:00.000+00:00', changedBy: { firstName: 'Sara', lastName: 'Khoury' } }]);
    if (path.endsWith('/transition') && method === 'POST') { file = { ...file, currentStage: STAGE('CUSTOMS_DECLARATION', 'Customs declaration') }; return ok({}); }
    if (path.endsWith('/assign') && method === 'POST') { file = { ...file, assignee: body.userId ? { id: 'u1', firstName: 'Sara', lastName: 'Khoury' } : null }; return ok(file); }
    if (path.endsWith('/close') && method === 'POST') { file = { ...file, status: 'CLOSED' }; return ok({}); }
    if (path.endsWith('/reopen') && method === 'POST') { file = { ...file, status: 'OPEN' }; return ok({}); }
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mount = (path: string) => render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
const sent = (method: string, suffix: string) => calls.filter((c) => c.method === method && c.path.endsWith(suffix));

describe('creating a file', () => {
  it('asks for a client first, then creates the file and opens it', async () => {
    mount('/files/new');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create file' }));
    expect(await screen.findByText('Choose a client')).toBeInTheDocument();
    expect(sent('POST', '/clearance-files')).toHaveLength(0);

    await screen.findByRole('option', { name: /Al Nour Trading/ });
    await user.selectOptions(screen.getByLabelText('Client'), 'c1');
    await user.selectOptions(screen.getByLabelText('Type'), 'EXPORT');
    await user.selectOptions(screen.getByLabelText('Priority'), 'HIGH');
    await user.selectOptions(screen.getByLabelText('Branch'), 'b1');
    await user.type(screen.getByLabelText('Customs reference'), ' CR-1 ');
    await user.click(screen.getByRole('button', { name: 'Create file' }));

    expect(await screen.findByRole('heading', { name: 'IMP-2026-00009' })).toBeInTheDocument();
    const [post] = sent('POST', '/clearance-files');
    expect(post.body).toEqual({ clientId: 'c1', fileType: 'EXPORT', priority: 'HIGH', branchId: 'b1', customsReference: 'CR-1' });
  });

  it('shows the server message when creation is refused', async () => {
    failNext['POST /clearance-files'] = fail(422, 'CLIENT_INACTIVE', 'This client is inactive');
    mount('/files/new');
    const user = userEvent.setup();
    await screen.findByRole('option', { name: /Al Nour Trading/ });
    await user.selectOptions(screen.getByLabelText('Client'), 'c1');
    await user.click(screen.getByRole('button', { name: 'Create file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This client is inactive');
  });

  it('is hidden without the create permission', async () => {
    permissions = ['clearance_files.view'];
    mount('/files');
    await screen.findByRole('heading', { name: 'Clearance Files' });
    expect(screen.queryByRole('link', { name: 'New file' })).not.toBeInTheDocument();
  });

  it('refuses the form address without the create permission', async () => {
    permissions = ['clearance_files.view'];
    mount('/files/new');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('file page', () => {
  it('shows the file, its details and the summary counts', async () => {
    mount('/files/f1');
    expect(await screen.findByRole('heading', { name: 'IMP-2026-00001' })).toBeInTheDocument();
    expect(screen.getAllByText('Al Nour Trading').length).toBeGreaterThan(0);
    expect(screen.getByText('CR-77')).toBeInTheDocument();
    expect(await screen.findByText('Handle with care')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('MSC Anna', { exact: false })).toBeInTheDocument());
    expect(await screen.findByText('5')).toBeInTheDocument(); // open tasks
  });

  it('says so when the file does not exist', async () => {
    mount('/files/f404');
    expect(await screen.findByText('This file does not exist or you cannot see it.')).toBeInTheDocument();
  });

  it('moves the file to the next stage', async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Move to Customs declaration/ }));
    await waitFor(() => expect(sent('POST', '/transition')).toHaveLength(1));
    expect(sent('POST', '/transition')[0].body).toEqual({ toStageId: 's-CUSTOMS_DECLARATION' });
    expect(await screen.findByText('Customs declaration', { selector: 'span' })).toBeInTheDocument();
  });

  it('explains why a stage cannot be entered yet and does not allow the click', async () => {
    transitions = [{
      transitionId: 't1', toStage: STAGE('CUSTOMS_DECLARATION', 'Customs declaration'), requiresReason: false, allowed: false,
      blockers: [{ code: 'REQUIRED_DOCUMENTS_MISSING', message: '1 required document(s) are missing', details: [{ nameEn: 'Commercial invoice', nameAr: 'فاتورة تجارية', state: 'MISSING' }] }],
    }];
    mount('/files/f1');
    const button = await screen.findByRole('button', { name: /Move to Customs declaration/ });
    expect(button).toBeDisabled();
    expect(screen.getByText(/Required documents are missing/)).toHaveTextContent('Commercial invoice');
  });

  it('asks for a reason when the stage change needs one', async () => {
    transitions = [{ transitionId: 't1', toStage: STAGE('ON_HOLD_STAGE', 'Waiting'), requiresReason: true, allowed: true, blockers: [] }];
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Move to Waiting/ }));
    expect(sent('POST', '/transition')).toHaveLength(0);
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Reason'), 'Client asked');
    await user.click(confirm);
    await waitFor(() => expect(sent('POST', '/transition')[0].body).toEqual({ toStageId: 's-ON_HOLD_STAGE', reason: 'Client asked' }));
  });

  it('shows the server refusal when a stage change is rejected', async () => {
    failNext['POST /clearance-files/f1/transition'] = fail(409, 'REQUIRED_DOCUMENTS_MISSING', 'Documents are missing');
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Move to Customs declaration/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Documents are missing');
  });

  it('assigns the file to the signed-in user, and back to nobody', async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Assign to me' }));
    await waitFor(() => expect(sent('POST', '/assign')[0].body).toEqual({ userId: 'u1' }));
    await user.click(await screen.findByRole('button', { name: 'Unassign' }));
    await waitFor(() => expect(sent('POST', '/assign')[1].body).toEqual({ userId: null }));
  });

  it('hides assignment, editing and closing without the permissions', async () => {
    permissions = ['clearance_files.view'];
    file = FILE({ currentStage: STAGE('DELIVERED', 'Delivered', true) });
    mount('/files/f1');
    await screen.findByRole('heading', { name: 'IMP-2026-00001' });
    expect(screen.queryByRole('button', { name: 'Assign to me' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close file' })).not.toBeInTheDocument();
  });

  it('edits the details and sends only what the form holds', async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.selectOptions(screen.getByLabelText('Priority'), 'URGENT');
    const ref = screen.getByLabelText('Customs reference');
    await user.clear(ref);
    await user.type(ref, 'CR-99');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/clearance-files/f1')).toHaveLength(1));
    expect(sent('PATCH', '/clearance-files/f1')[0].body).toMatchObject({ priority: 'URGENT', customsReference: 'CR-99', internalNotes: 'Handle with care', expectedArrivalAt: '2026-11-20T00:00:00.000Z' });
    expect(await screen.findByText('CR-99')).toBeInTheDocument();
  });

  it('shows the activity and the stage history', async () => {
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Activity' }));
    expect(await screen.findByText('File IMP-2026-00001 created for Al Nour Trading')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Stage history' }));
    expect(await screen.findByText(/File created/)).toBeInTheDocument();
  });
});

describe('closing and reopening', () => {
  beforeEach(() => { file = FILE({ currentStage: STAGE('DELIVERED', 'Delivered', true) }); transitions = []; });

  it('cannot close while the checks fail, and says why', async () => {
    closure = { canClose: false, blockers: [{ code: 'OPEN_TASKS_REMAIN', message: '2 task(s) are still open' }], warnings: [] };
    mount('/files/f1');
    expect(await screen.findByText('Open tasks must be completed first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close file' })).toBeDisabled();
  });

  it('needs an explicit acknowledgement when invoices are unpaid', async () => {
    closure = { canClose: true, blockers: [], warnings: [{ code: 'OUTSTANDING_BALANCE', message: 'x' }] };
    mount('/files/f1');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Close file' }));
    const confirm = screen.getAllByRole('button', { name: 'Close file' })[0];
    expect(confirm).toBeDisabled();
    await user.click(screen.getByLabelText('I understand that some invoices are not fully paid'));
    await user.click(confirm);
    await waitFor(() => expect(sent('POST', '/close')[0].body).toEqual({ acknowledgeOutstanding: true }));
  });

  it('reopens a closed file only with a reason', async () => {
    file = FILE({ status: 'CLOSED', currentStage: STAGE('DELIVERED', 'Delivered', true) });
    mount('/files/f1');
    const user = userEvent.setup();
    const button = await screen.findByRole('button', { name: 'Reopen file' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Reason for reopening'), 'Missing payment');
    await user.click(button);
    await waitFor(() => expect(sent('POST', '/reopen')[0].body).toEqual({ reason: 'Missing payment' }));
  });
});

describe('Arabic', () => {
  it('translates the file page and keeps file numbers left-to-right', async () => {
    setLocale('ar');
    mount('/files/f1');
    const heading = await screen.findByRole('heading', { name: 'IMP-2026-00001' });
    expect(heading).toHaveAttribute('dir', 'ltr');
    expect(within(screen.getByRole('tablist')).getByRole('tab', { name: 'النشاط' })).toBeInTheDocument();
  });
});
