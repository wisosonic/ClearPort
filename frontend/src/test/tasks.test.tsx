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
const ME = { id: 'u1', firstName: 'Sara', lastName: 'Khoury' };
const OTHER = { id: 'u2', firstName: 'Omar', lastName: 'Haddad' };
/** A due date is the end of a local day; build fixtures the same way so the tests pass in any time zone. */
const endOfDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59).toISOString();
const TASK = (over: Record<string, unknown> = {}) => ({
  id: 't1', clearanceFileId: 'f1', clearanceFile: { id: 'f1', fileNumber: 'IMP-2026-00001' }, assignedTo: 'u1', title: 'Collect the original BL', description: 'from the agent',
  priority: 'HIGH', status: 'OPEN', dueAt: endOfDay(2026, 11, 10), completedAt: null, assignee: ME, createdByUser: ME, isOverdue: false, ...over,
});

const MEMBER = ['clearance_files.view', 'tasks.view'];
const MANAGER = [...MEMBER, 'tasks.manage', 'users.manage'];
let permissions: string[];
let fileStatus: string;
let tasks: ReturnType<typeof TASK>[];
let calls: { method: string; path: string; query: URLSearchParams; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...MEMBER];
  fileStatus = 'OPEN';
  tasks = [TASK()];
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const [rawPath, qs = ''] = url.replace('/api/v1', '').split('?');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: rawPath, query: new URLSearchParams(qs), body });
    const key = `${method} ${rawPath}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (rawPath === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (rawPath === '/auth/me') return ok({
      user: { ...ME, email: 'a@b.c' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (rawPath === '/clearance-files/f1' && method === 'GET') return ok(FILE(fileStatus));
    if (rawPath.endsWith('/transitions')) return ok({ currentStage: null, status: fileStatus, transitions: [] });
    if (rawPath.endsWith('/summary')) return ok({ counts: { shipments: 0, containers: 0, goodsLines: 0, documents: 0, openTasks: tasks.length } });
    if ((rawPath === '/tasks' || rawPath === '/clearance-files/f1/tasks') && method === 'GET') return ok(tasks, { page: 1, limit: 20, total: tasks.length });
    if (rawPath === '/users') return ok([ME, OTHER], { page: 1, limit: 100, total: 2 });
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'new' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const mountAt = async (path: string, tab?: string) => {
  render(<App router={createTestRouter(path) as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  if (tab) await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('file tasks tab', () => {
  it('lists the file tasks with priority, due date and assignee', async () => {
    tasks = [TASK(), TASK({ id: 't2', title: 'Pay the port fees', isOverdue: true, assignedTo: 'u2', assignee: OTHER, status: 'IN_PROGRESS', dueAt: endOfDay(2026, 10, 1) })];
    await mountAt('/files/f1', 'Tasks');
    const first = (await screen.findByText('Collect the original BL')).closest('tr')!;
    expect(within(first).getByText('from the agent')).toBeInTheDocument();
    expect(within(first).getByText('High')).toBeInTheDocument();
    expect(within(first).getByText('10 Nov 2026')).toBeInTheDocument();
    const second = screen.getByText('Pay the port fees').closest('tr')!;
    expect(within(second).getByText('Overdue')).toBeInTheDocument();
    expect(within(second).getByText('Omar Haddad')).toBeInTheDocument();
    expect(sent('GET', '/clearance-files/f1/tasks')[0].query.get('state')).toBe('open');
  });

  it('is hidden without tasks.view', async () => {
    permissions = ['clearance_files.view'];
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('heading', { name: 'IMP-2026-00001' });
    expect(screen.queryByRole('tab', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  it('lets a member work on their own task but not manage it', async () => {
    tasks = [TASK(), TASK({ id: 't2', title: 'Someone else task', assignedTo: 'u2', assignee: OTHER })];
    const user = await mountAt('/files/f1', 'Tasks');
    await screen.findByText('Collect the original BL');
    expect(screen.queryByRole('button', { name: /Add task/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel task/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    const other = screen.getByText('Someone else task').closest('tr')!;
    expect(within(other).queryByRole('button')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Start: Collect the original BL' }));
    await waitFor(() => expect(sent('PATCH', '/tasks/t1')[0]?.body).toEqual({ status: 'IN_PROGRESS' }));
    await user.click(screen.getByRole('button', { name: 'Complete: Collect the original BL' }));
    await waitFor(() => expect(sent('POST', '/tasks/t1/complete')).toHaveLength(1));
  });

  it('refreshes what depends on tasks after completing one', async () => {
    const user = await mountAt('/files/f1', 'Tasks');
    await user.click(await screen.findByRole('button', { name: 'Complete: Collect the original BL' }));
    await waitFor(() => expect(sent('POST', '/tasks/t1/complete')).toHaveLength(1));
    await waitFor(() => expect(sent('GET', '/clearance-files/f1/transitions').length).toBeGreaterThan(1)); // a blocked stage move may now be free
    expect(sent('GET', '/clearance-files/f1/tasks').length).toBeGreaterThan(1);
  });

  it('reopens a finished task', async () => {
    tasks = [TASK({ status: 'DONE', completedAt: '2026-11-05T10:00:00.000+00:00' })];
    const user = await mountAt('/files/f1', 'Tasks');
    await user.click(await screen.findByRole('button', { name: /Reopen: / }));
    await waitFor(() => expect(sent('PATCH', '/tasks/t1')[0].body).toEqual({ status: 'OPEN' }));
  });

  it('shows the server refusal next to the task', async () => {
    failNext['POST /tasks/t1/complete'] = fail(403, 'PERMISSION_DENIED', 'You can only complete tasks assigned to you');
    const user = await mountAt('/files/f1', 'Tasks');
    await user.click(await screen.findByRole('button', { name: /Complete: / }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You can only complete tasks assigned to you');
  });

  it('is read-only on a closed file', async () => {
    permissions = [...MANAGER];
    fileStatus = 'CLOSED';
    await mountAt('/files/f1', 'Tasks');
    await screen.findByText('Collect the original BL');
    expect(screen.queryByRole('button', { name: /Add task/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Complete: / })).not.toBeInTheDocument();
  });
});

describe('managing tasks', () => {
  beforeEach(() => { permissions = [...MANAGER]; });

  it('needs a title, then creates the task on the file due at the end of the day', async () => {
    const user = await mountAt('/files/f1', 'Tasks');
    await user.click(await screen.findByRole('button', { name: 'Add task' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give the task a title')).toBeInTheDocument();
    expect(sent('POST', '/tasks')).toHaveLength(0);

    await user.type(screen.getByLabelText('Task'), 'Call the agent');
    await user.selectOptions(screen.getByLabelText('Priority'), 'URGENT');
    await user.type(screen.getByLabelText('Due'), '2026-11-12');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')).toHaveLength(1));
    expect(sent('POST', '/tasks')[0].body).toEqual({ title: 'Call the agent', priority: 'URGENT', dueAt: endOfDay(2026, 11, 12), clearanceFileId: 'f1' });
  });

  it('can assign a new task to another employee', async () => {
    const user = await mountAt('/files/f1', 'Tasks');
    await user.click(await screen.findByRole('button', { name: 'Add task' }));
    await user.type(screen.getByLabelText('Task'), 'Check the seals');
    await screen.findByRole('option', { name: 'Omar Haddad' });
    await user.selectOptions(screen.getByLabelText('Assigned to'), 'u2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/tasks')[0]?.body).toMatchObject({ assignedTo: 'u2', clearanceFileId: 'f1' }));
  });

  it('edits a task and cancels another', async () => {
    const user = await mountAt('/files/f1', 'Tasks');
    await user.click(await screen.findByRole('button', { name: 'Edit: Collect the original BL' }));
    const title = screen.getByLabelText('Task');
    await user.clear(title);
    await user.type(title, 'Collect BL and invoice');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/tasks/t1')).toHaveLength(1));
    expect(sent('PATCH', '/tasks/t1')[0].body).toEqual({ title: 'Collect BL and invoice', description: 'from the agent', priority: 'HIGH', dueAt: endOfDay(2026, 11, 10) });

    await user.click(await screen.findByRole('button', { name: /Cancel task: / }));
    await waitFor(() => expect(sent('PATCH', '/tasks/t1')[1].body).toEqual({ status: 'CANCELLED' }));
  });
});

describe('tasks page', () => {
  it('shows only my tasks by default for a member, with a link to each file', async () => {
    await mountAt('/tasks');
    expect(await screen.findByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'IMP-2026-00001' })).toHaveAttribute('href', '/files/f1');
    expect(sent('GET', '/tasks')[0].query.get('assignedTo')).toBe('me');
  });

  it('shows the whole office for a manager, and filters by overdue and finished', async () => {
    permissions = [...MANAGER];
    const user = await mountAt('/tasks');
    await screen.findByText('Collect the original BL');
    expect(sent('GET', '/tasks')[0].query.get('assignedTo')).toBeNull();
    await user.click(screen.getByLabelText('Overdue only'));
    await waitFor(() => expect(sent('GET', '/tasks').at(-1)!.query.get('overdue')).toBe('true'));
    await user.selectOptions(screen.getByLabelText('Show'), 'closed');
    await waitFor(() => expect(sent('GET', '/tasks').at(-1)!.query.get('state')).toBe('closed'));
  });

  it('is not available without tasks.view', async () => {
    permissions = ['clearance_files.view'];
    await mountAt('/tasks');
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });

  it('works in Arabic', async () => {
    setLocale('ar');
    await mountAt('/tasks');
    expect(await screen.findByRole('heading', { name: 'المهام' })).toBeInTheDocument();
    expect(await screen.findByText('مفتوحة')).toBeInTheDocument();
  });
});
