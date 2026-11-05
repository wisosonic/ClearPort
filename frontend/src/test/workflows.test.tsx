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

const STAGES = [
  { id: 's1', code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد', sequence: 1, isTerminal: false },
  { id: 's2', code: 'CUSTOMS', nameEn: 'Customs review', nameAr: 'المعاينة', sequence: 2, isTerminal: false },
  { id: 's3', code: 'DONE', nameEn: 'Completed', nameAr: 'مكتمل', sequence: 3, isTerminal: true },
];
const TRANSITIONS = [
  { id: 't1', fromStageId: 's1', toStageId: 's2', requiredPermission: null, requiresDocumentCheck: true, requiresApproval: false, requiresReason: false, requiredTaskCheck: false },
  { id: 't2', fromStageId: 's2', toStageId: 's3', requiredPermission: 'clearance_files.close', requiresDocumentCheck: false, requiresApproval: true, requiresReason: false, requiredTaskCheck: true },
];
const TEMPLATES = [
  { id: 'w1', name: 'Standard import', fileType: 'IMPORT', description: 'Sea imports', isActive: true, stages: STAGES, transitions: TRANSITIONS },
  { id: 'w2', name: 'Draft export', fileType: 'EXPORT', description: null, isActive: false, stages: [], transitions: [] },
];

let permissions: string[];
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['workflows.manage', 'clearance_files.view'];
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
    if (path === '/workflow-templates' && method === 'GET') return ok(TEMPLATES);
    if (path === '/permissions') return ok([{ id: 'p1', code: 'clearance_files.close', description: 'x' }, { id: 'p2', code: 'documents.review', description: 'y' }]);
    if (method === 'DELETE') return res(204, null);
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async () => {
  render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  return userEvent.setup();
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const edit = async (user: ReturnType<typeof userEvent.setup>, name = 'Standard import') => user.click(await screen.findByRole('button', { name: `Edit stages and rules ${name}` }));

describe('workflow list', () => {
  it('is reachable with only workflows.manage, and shows only the tabs that permission covers', async () => {
    await open();
    expect(await screen.findByText('Standard import')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((x) => x.textContent)).toEqual(['Workflows', 'Required documents']);
    expect(screen.queryByRole('tab', { name: 'Office' })).not.toBeInTheDocument();
  });

  it('shows the Office tabs too with both permissions', async () => {
    permissions = ['settings.manage', 'workflows.manage', 'clearance_files.view'];
    await open();
    expect(await screen.findByRole('tab', { name: 'Office' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Workflows' })).toBeInTheDocument();
  });

  it('lists templates with type, in-use state and counts', async () => {
    await open();
    const card = (await screen.findByText('Standard import')).closest('.p-5')! as HTMLElement;
    expect(within(card).getByText('Import')).toBeInTheDocument();
    expect(within(card).getByText('In use')).toBeInTheDocument();
    expect(within(card).getByText('3 stages, 2 transitions')).toBeInTheDocument();
    const draft = screen.getByText('Draft export').closest('.p-5')! as HTMLElement;
    expect(within(draft).getByText('Not in use')).toBeInTheDocument();
  });

  it('is refused without settings.manage or workflows.manage', async () => {
    permissions = ['clearance_files.view'];
    await open();
    expect(await screen.findByText('You do not have access to this page.')).toBeInTheDocument();
  });
});

describe('templates', () => {
  it('creates a template that starts not in use', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'New workflow' }));
    const form = (await screen.findByRole('heading', { name: 'New workflow', level: 3 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Enter a name/)).toBeInTheDocument();
    expect(within(form).getByText(/starts not in use/)).toBeInTheDocument();
    await user.type(within(form).getByLabelText('Name'), 'Air freight');
    await user.selectOptions(within(form).getByLabelText('File type'), 'OTHER');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/workflow-templates')).toHaveLength(1));
    expect(sent('POST', '/workflow-templates')[0].body).toEqual({ name: 'Air freight', fileType: 'OTHER' });
  });

  it('renames, keeping the type', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Rename Standard import' }));
    const input = await screen.findByLabelText('Name');
    await user.clear(input);
    await user.type(input, 'Sea imports v2');
    await user.click(within(input.closest('form')!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/workflow-templates/w1')).toHaveLength(1));
    expect(sent('PATCH', '/workflow-templates/w1')[0].body).toEqual({ name: 'Sea imports v2', description: 'Sea imports' });
  });

  it('starts and stops using a template, showing the server refusal', async () => {
    failNext['PATCH /workflow-templates/w2'] = fail(422, 'TEMPLATE_HAS_NO_STAGES', 'Add at least one stage before activating the template');
    const user = await open();
    await user.click(await screen.findByRole('button', { name: 'Start using Draft export' }));
    expect(await screen.findByText('Add at least one stage before activating the template')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop using Standard import' }));
    await waitFor(() => expect(sent('PATCH', '/workflow-templates/w1')).toHaveLength(1));
    expect(sent('PATCH', '/workflow-templates/w1')[0].body).toEqual({ isActive: false });
  });
});

describe('stages', () => {
  it('lists stages in order with both names and the final stage marked', async () => {
    const user = await open();
    await edit(user);
    const row = (await screen.findByText('Customs review')).closest('tr')!;
    expect(within(row).getByText('CUSTOMS')).toBeInTheDocument();
    expect(within(row).getByText('المعاينة')).toBeInTheDocument();
    expect(within(screen.getByText('Completed').closest('tr')!).getByText('Final stage')).toBeInTheDocument();
  });

  it('adds a stage: valid code and both names are required', async () => {
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Add stage' }));
    const form = (await screen.findByRole('heading', { name: 'Add stage', level: 4 })).closest('form')!;
    await user.type(within(form).getByLabelText('Code'), '9x');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Start with a letter/)).toBeInTheDocument();
    expect(within(form).getAllByText('Enter a name')).toHaveLength(2);
    expect(sent('POST', '/workflow-templates/w1/stages')).toHaveLength(0);
    await user.clear(within(form).getByLabelText('Code'));
    await user.type(within(form).getByLabelText('Code'), 'inspection');
    await user.type(within(form).getByLabelText('Name (English)'), 'Inspection');
    await user.type(within(form).getByLabelText('Name (Arabic)'), 'الكشف');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/workflow-templates/w1/stages')).toHaveLength(1));
    expect(sent('POST', '/workflow-templates/w1/stages')[0].body).toEqual({ code: 'inspection', nameEn: 'Inspection', nameAr: 'الكشف', isTerminal: false });
  });

  it('edits names and the final flag; the code and order are fixed', async () => {
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Edit CUSTOMS' }));
    expect(screen.queryByLabelText('Code CUSTOMS')).not.toBeInTheDocument();
    const en = screen.getByLabelText('Name (English) CUSTOMS');
    await user.clear(en);
    await user.type(en, 'Customs inspection');
    await user.click(within(en.closest('tr')!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/workflow-templates/w1/stages/s2')).toHaveLength(1));
    expect(sent('PATCH', '/workflow-templates/w1/stages/s2')[0].body).toEqual({ nameEn: 'Customs inspection', nameAr: 'المعاينة', isTerminal: false });
  });

  it('moves a stage up or down by sending the whole new order; the ends cannot move further', async () => {
    const user = await open();
    await edit(user);
    expect(await screen.findByRole('button', { name: 'Move up NEW_FILE' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move down DONE' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Move up CUSTOMS' }));
    await waitFor(() => expect(sent('POST', '/workflow-templates/w1/stages/reorder')).toHaveLength(1));
    expect(sent('POST', '/workflow-templates/w1/stages/reorder')[0].body).toEqual({ stageIds: ['s2', 's1', 's3'] });
  });

  it('removes a stage only after confirming, and shows the refusal when files have used it', async () => {
    failNext['DELETE /workflow-templates/w1/stages/s2'] = fail(409, 'STAGE_IN_USE', 'Files are currently at this stage');
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Remove CUSTOMS' }));
    expect(sent('DELETE', '/workflow-templates/w1/stages/s2')).toHaveLength(0);
    await user.click(within(screen.getByText(/Remove the stage "Customs review"/).parentElement!).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Files are currently at this stage')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove CUSTOMS' }));
    await user.click(within(screen.getByText(/Remove the stage "Customs review"/).parentElement!).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent('DELETE', '/workflow-templates/w1/stages/s2')).toHaveLength(2));
  });

  it('shows the server refusal when a stage with moves out of it is made final', async () => {
    failNext['PATCH /workflow-templates/w1/stages/s2'] = fail(409, 'STAGE_HAS_TRANSITIONS', "Remove this stage's outgoing transitions before making it terminal");
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Edit CUSTOMS' }));
    const row = screen.getByLabelText('Name (English) CUSTOMS').closest('tr')!;
    await user.click(within(row).getByLabelText('Final stage'));
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/outgoing transitions before making it terminal/)).toBeInTheDocument();
  });
});

describe('transitions', () => {
  it('shows each move with its rules as badges', async () => {
    const user = await open();
    await edit(user);
    const first = (await screen.findByRole('button', { name: 'Edit New file → Customs review' })).closest('tr')!;
    expect(within(first).getByText('Documents complete')).toBeInTheDocument();
    const second = screen.getByRole('button', { name: 'Edit Customs review → Completed' }).closest('tr')!;
    expect(within(second).getByText('Needs approval')).toBeInTheDocument();
    expect(within(second).getByText('No open tasks')).toBeInTheDocument();
    expect(within(second).getByText('clearance_files.close')).toBeInTheDocument();
  });

  it('adds a move: stages must differ, and a final stage cannot be a starting point', async () => {
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Add move' }));
    const form = (await screen.findByRole('heading', { name: 'Add move', level: 4 })).closest('form')!;
    const from = within(form).getByLabelText('From');
    expect(within(from).queryByRole('option', { name: 'Completed' })).not.toBeInTheDocument();
    expect(within(within(form).getByLabelText('To')).getByRole('option', { name: 'Completed' })).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Choose a stage')).toBeInTheDocument();
    await user.selectOptions(from, 's1');
    await user.selectOptions(within(form).getByLabelText('To'), 's1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Choose a different stage')).toBeInTheDocument();
    expect(sent('POST', '/workflow-templates/w1/transitions')).toHaveLength(0);
    await user.selectOptions(within(form).getByLabelText('To'), 's3');
    await user.click(within(form).getByLabelText('Needs a reason'));
    await user.type(within(form).getByLabelText('Permission needed'), 'documents.review');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/workflow-templates/w1/transitions')).toHaveLength(1));
    expect(sent('POST', '/workflow-templates/w1/transitions')[0].body).toEqual({
      fromStageId: 's1', toStageId: 's3', requiresDocumentCheck: false, requiresApproval: false, requiresReason: true, requiredTaskCheck: false, requiredPermission: 'documents.review',
    });
  });

  it('edits the rules and can clear the permission', async () => {
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Edit Customs review → Completed' }));
    const row = screen.getByLabelText('Permission needed').closest('tr')!;
    await user.clear(within(row).getByLabelText('Permission needed'));
    await user.click(within(row).getByLabelText('Needs approval'));
    await user.click(within(row).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/workflow-templates/w1/transitions/t2')).toHaveLength(1));
    expect(sent('PATCH', '/workflow-templates/w1/transitions/t2')[0].body).toEqual({
      requiresDocumentCheck: false, requiresApproval: false, requiresReason: false, requiredTaskCheck: true, requiredPermission: null,
    });
  });

  it('shows the server refusal for an unknown permission', async () => {
    failNext['PATCH /workflow-templates/w1/transitions/t1'] = fail(422, 'UNKNOWN_PERMISSION', 'Unknown permission code nope.nope');
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Edit New file → Customs review' }));
    await user.type(screen.getByLabelText('Permission needed'), 'nope.nope');
    await user.click(within(screen.getByLabelText('Permission needed').closest('tr')!).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Unknown permission code nope.nope')).toBeInTheDocument();
  });

  it('removes a move only after confirming', async () => {
    const user = await open();
    await edit(user);
    await user.click(await screen.findByRole('button', { name: 'Remove New file → Customs review' }));
    expect(sent('DELETE', '/workflow-templates/w1/transitions/t1')).toHaveLength(0);
    const confirm = within(screen.getByText(/Remove the move New file → Customs review\?/).parentElement!).getByRole('button', { name: 'Remove' });
    await user.click(confirm);
    await waitFor(() => expect(sent('DELETE', '/workflow-templates/w1/transitions/t1')).toHaveLength(1));
  });
});

describe('Arabic', () => {
  it('shows the tab and rules in Arabic', async () => {
    setLocale('ar');
    const user = await open();
    expect(await screen.findByRole('tab', { name: 'مسارات العمل' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'تعديل المراحل والقواعد Standard import' }));
    expect(await screen.findByText('اكتمال المستندات')).toBeInTheDocument();
  });
});
