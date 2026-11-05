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

const TYPES = [
  { id: 'dt1', tenantId: null, code: 'COMMERCIAL_INVOICE', nameEn: 'Commercial invoice', nameAr: 'فاتورة تجارية', description: 'From the seller', isActive: true },
  { id: 'dt2', tenantId: null, code: 'BILL_OF_LADING', nameEn: 'Bill of lading', nameAr: 'بوليصة الشحن', description: null, isActive: true },
  { id: 'dt3', tenantId: 't', code: 'HEALTH_CERT', nameEn: 'Health certificate', nameAr: 'شهادة صحية', description: 'For food', isActive: true },
  { id: 'dt4', tenantId: 't', code: 'OLD_FORM', nameEn: 'Old form', nameAr: 'نموذج قديم', description: null, isActive: false },
];
const STAGE = (id: string, code: string, en: string, ar: string, sequence: number, isTerminal = false) => ({ id, code, nameEn: en, nameAr: ar, sequence, isTerminal });
const TEMPLATES = [
  { id: 'w1', name: 'Standard import', fileType: 'IMPORT', description: null, isActive: true, stages: [STAGE('s1', 'NEW', 'New file', 'ملف جديد', 1), STAGE('s2', 'CUSTOMS', 'Customs review', 'المعاينة', 2), STAGE('s3', 'DONE', 'Completed', 'مكتمل', 3, true)], transitions: [] },
  { id: 'w2', name: 'Old import flow', fileType: 'IMPORT', description: null, isActive: false, stages: [STAGE('s9', 'LEGACY', 'Legacy stage', 'مرحلة قديمة', 1)], transitions: [] },
  { id: 'w3', name: 'Export flow', fileType: 'EXPORT', description: null, isActive: true, stages: [STAGE('s5', 'PACK', 'Packing', 'التعبئة', 1)], transitions: [] },
];
const REQS = [
  { id: 'r1', fileType: 'IMPORT', documentTypeId: 'dt1', isRequired: true, isRequiredBeforeStageId: null, appliesTo: null, documentType: TYPES[0], requiredBefore: null },
  { id: 'r2', fileType: 'IMPORT', documentTypeId: 'dt2', isRequired: true, isRequiredBeforeStageId: 's2', appliesTo: 'Sea shipments only', documentType: TYPES[1], requiredBefore: { id: 's2', code: 'CUSTOMS', nameEn: 'Customs review', nameAr: 'المعاينة' }, conditions: { shipmentType: ['SEA'], hasContainers: true } },
  { id: 'r3', fileType: 'EXPORT', documentTypeId: 'dt3', isRequired: false, isRequiredBeforeStageId: null, appliesTo: null, documentType: TYPES[2], requiredBefore: null },
];

let permissions: string[];
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = ['settings.manage', 'workflows.manage', 'documents.view', 'clearance_files.view'];
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
    if (path === '/document-types' && method === 'GET') return ok(TYPES);
    if (path === '/document-requirements' && method === 'GET') return ok(REQS);
    if (path === '/workflow-templates') return ok(TEMPLATES);
    if (method === 'DELETE') return res(204, null);
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'x' });
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async (tab: string) => {
  render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: tab }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

describe('document types', () => {
  it('lists built-in and custom types; only custom ones can be changed', async () => {
    await open('Document types');
    const builtIn = (await screen.findByText('COMMERCIAL_INVOICE')).closest('tr')!;
    expect(within(builtIn).getByText('Built-in')).toBeInTheDocument();
    expect(within(builtIn).queryByRole('button')).not.toBeInTheDocument();
    const custom = screen.getByText('HEALTH_CERT').closest('tr')!;
    expect(within(custom).getByText('Custom')).toBeInTheDocument();
    expect(within(custom).getByRole('button', { name: 'Edit HEALTH_CERT' })).toBeInTheDocument();
    expect(within(screen.getByText('OLD_FORM').closest('tr')!).getByText('Inactive')).toBeInTheDocument();
  });

  it('adds a type: code and both names are required', async () => {
    const user = await open('Document types');
    await user.click(await screen.findByRole('button', { name: 'Add document type' }));
    const form = (await screen.findByRole('heading', { name: 'Add document type', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText(/Start with a letter/)).toBeInTheDocument();
    expect(within(form).getAllByText('Enter a name')).toHaveLength(2);
    expect(sent('POST', '/document-types')).toHaveLength(0);
    await user.type(within(form).getByLabelText('Code'), 'packing_cert');
    await user.type(within(form).getByLabelText('Name (English)'), 'Packing certificate');
    await user.type(within(form).getByLabelText('Name (Arabic)'), 'شهادة تعبئة');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/document-types')).toHaveLength(1));
    expect(sent('POST', '/document-types')[0].body).toEqual({ code: 'packing_cert', nameEn: 'Packing certificate', nameAr: 'شهادة تعبئة' });
  });

  it('edits names and description (the code stays), and deactivates', async () => {
    const user = await open('Document types');
    await user.click(await screen.findByRole('button', { name: 'Edit HEALTH_CERT' }));
    const form = (await screen.findByRole('heading', { name: 'Edit document type', level: 2 })).closest('form')!;
    expect(within(form).queryByLabelText('Code')).not.toBeInTheDocument();
    await user.clear(within(form).getByLabelText('Description'));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/document-types/dt3')).toHaveLength(1));
    expect(sent('PATCH', '/document-types/dt3')[0].body).toEqual({ nameEn: 'Health certificate', nameAr: 'شهادة صحية', description: null });
    await user.click(await screen.findByRole('button', { name: 'Deactivate HEALTH_CERT' }));
    await waitFor(() => expect(sent('PATCH', '/document-types/dt3')).toHaveLength(2));
    expect(sent('PATCH', '/document-types/dt3')[1].body).toEqual({ isActive: false });
  });

  it('shows the server refusal for a reserved code', async () => {
    failNext['POST /document-types'] = fail(409, 'DOCUMENT_TYPE_CODE_RESERVED', 'Code BILL_OF_LADING is used by a system document type');
    const user = await open('Document types');
    await user.click(await screen.findByRole('button', { name: 'Add document type' }));
    await user.type(await screen.findByLabelText('Code'), 'BILL_OF_LADING');
    await user.type(screen.getByLabelText('Name (English)'), 'x');
    await user.type(screen.getByLabelText('Name (Arabic)'), 'س');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/is used by a system document type/)).toBeInTheDocument();
  });

  it('is hidden without settings.manage', async () => {
    permissions = ['workflows.manage', 'clearance_files.view'];
    render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('tab', { name: 'Required documents' });
    expect(screen.queryByRole('tab', { name: 'Document types' })).not.toBeInTheDocument();
  });
});

describe('required documents', () => {
  it('lists requirements per kind of file, with when each is needed', async () => {
    await open('Required documents');
    expect(await screen.findByRole('heading', { name: 'Import files' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Export files' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Other files' })).not.toBeInTheDocument();
    const invoice = screen.getByText('Commercial invoice').closest('tr')!;
    expect(within(invoice).getByText('Required')).toBeInTheDocument();
    expect(within(invoice).getByText('The file is finished')).toBeInTheDocument();
    const bl = screen.getByText('Bill of lading').closest('tr')!;
    expect(within(bl).getByText('Customs review')).toBeInTheDocument();
    expect(within(bl).getByText('Sea shipments only')).toBeInTheDocument();
    expect(within(screen.getByText('Health certificate').closest('tr')!).getByText('Optional')).toBeInTheDocument();
  });

  it('asks only for some files: conditions are shown, sent when set, and cleared with null', async () => {
    const user = await open('Required documents');
    const bl = (await screen.findByText('Bill of lading')).closest('tr')!;
    expect(within(bl).getByText('Only shipments by Sea · File has containers')).toBeInTheDocument();
    await user.click(within(bl).getByRole('button', { name: 'Edit Bill of lading' }));
    const form = (await screen.findByRole('heading', { name: 'Edit requirement' })).closest('form')!;
    expect(within(form).getByLabelText('Sea')).toBeChecked();
    expect(within(form).getByLabelText('Containers')).toHaveValue('yes');
    await user.click(within(form).getByLabelText('Sea')); // untick
    await user.selectOptions(within(form).getByLabelText('Containers'), 'any');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/document-requirements/r2')).toHaveLength(1));
    expect(sent('PATCH', '/document-requirements/r2')[0].body).toMatchObject({ conditions: null });
  });

  it('adds a requirement with conditions only when some are chosen', async () => {
    const user = await open('Required documents');
    await user.click(await screen.findByRole('button', { name: 'Add requirement' }));
    const form = (await screen.findByRole('heading', { name: 'Add requirement', level: 2 })).closest('form')!;
    await user.selectOptions(within(form).getByLabelText('Document type'), 'dt3');
    await user.click(within(form).getByLabelText('Urgent'));
    await user.click(within(form).getByLabelText('High'));
    await user.selectOptions(within(form).getByLabelText('Client is'), 'COMPANY');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/document-requirements')).toHaveLength(1));
    expect(sent('POST', '/document-requirements')[0].body).toMatchObject({ conditions: { priority: ['HIGH', 'URGENT'], clientType: 'COMPANY' } });
  });

  it('adds a requirement: the stages offered belong to that kind of file, the workflow in use first', async () => {
    const user = await open('Required documents');
    await user.click(await screen.findByRole('button', { name: 'Add requirement' }));
    const form = (await screen.findByRole('heading', { name: 'Add requirement', level: 2 })).closest('form')!;
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Choose the type of document')).toBeInTheDocument();
    expect(sent('POST', '/document-requirements')).toHaveLength(0);
    const stage = within(form).getByLabelText('Needed before stage');
    await waitFor(() => expect(within(stage).getByRole('option', { name: 'Customs review' })).toBeInTheDocument());
    expect(within(stage).getByRole('option', { name: 'Legacy stage (Old import flow)' })).toBeInTheDocument(); // a workflow not in use says so
    expect(within(stage).queryByRole('option', { name: 'Packing' })).not.toBeInTheDocument(); // an export stage
    await user.selectOptions(within(form).getByLabelText('Document type'), 'dt3');
    await user.selectOptions(stage, 's2');
    await user.type(within(form).getByLabelText('Applies to'), 'Food only');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('POST', '/document-requirements')).toHaveLength(1));
    expect(sent('POST', '/document-requirements')[0].body).toEqual({ fileType: 'IMPORT', documentTypeId: 'dt3', isRequired: true, isRequiredBeforeStageId: 's2', appliesTo: 'Food only' });
  });

  it('changing the kind of file changes the stages offered; inactive document types are not offered', async () => {
    const user = await open('Required documents');
    await user.click(await screen.findByRole('button', { name: 'Add requirement' }));
    const form = (await screen.findByRole('heading', { name: 'Add requirement', level: 2 })).closest('form')!;
    await waitFor(() => expect(within(within(form).getByLabelText('Document type')).getByRole('option', { name: 'Health certificate' })).toBeInTheDocument());
    expect(within(within(form).getByLabelText('Document type')).queryByRole('option', { name: 'Old form' })).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('File type'), 'EXPORT');
    expect(await within(within(form).getByLabelText('Needed before stage')).findByRole('option', { name: 'Packing' })).toBeInTheDocument();
    expect(within(within(form).getByLabelText('Needed before stage')).queryByRole('option', { name: 'Customs review' })).not.toBeInTheDocument();
  });

  it('edits mandatory, stage and note; the file kind and document type are fixed', async () => {
    const user = await open('Required documents');
    await user.click(await screen.findByRole('button', { name: 'Edit Commercial invoice' }));
    const form = (await screen.findByRole('heading', { name: 'Edit requirement', level: 2 })).closest('form')!;
    expect(within(form).getByLabelText('File type')).toBeDisabled();
    expect(within(form).getByLabelText('Document type')).toBeDisabled();
    await user.click(within(form).getByLabelText(/Mandatory/));
    await waitFor(() => expect(within(within(form).getByLabelText('Needed before stage')).getByRole('option', { name: 'Customs review' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Needed before stage'), 's2');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent('PATCH', '/document-requirements/r1')).toHaveLength(1));
    expect(sent('PATCH', '/document-requirements/r1')[0].body).toEqual({ isRequired: false, isRequiredBeforeStageId: 's2', appliesTo: null });
  });

  it('removes a requirement only after confirming, and shows a refusal', async () => {
    failNext['DELETE /document-requirements/r3'] = fail(404, 'REQUIREMENT_NOT_FOUND', 'Document requirement not found');
    const user = await open('Required documents');
    await user.click(await screen.findByRole('button', { name: 'Remove Commercial invoice' }));
    expect(sent('DELETE', '/document-requirements/r1')).toHaveLength(0);
    await user.click(within(screen.getByText('Stop requiring Commercial invoice?').parentElement!).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent('DELETE', '/document-requirements/r1')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Remove Health certificate' }));
    await user.click(within(screen.getByText('Stop requiring Health certificate?').parentElement!).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Document requirement not found')).toBeInTheDocument();
  });

  it('shows the server refusal when adding a duplicate', async () => {
    failNext['POST /document-requirements'] = fail(409, 'REQUIREMENT_EXISTS', 'This requirement already exists');
    const user = await open('Required documents');
    await user.click(await screen.findByRole('button', { name: 'Add requirement' }));
    const form = (await screen.findByRole('heading', { name: 'Add requirement', level: 2 })).closest('form')!;
    await waitFor(() => expect(within(within(form).getByLabelText('Document type')).getByRole('option', { name: 'Commercial invoice' })).toBeInTheDocument());
    await user.selectOptions(within(form).getByLabelText('Document type'), 'dt1');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('This requirement already exists')).toBeInTheDocument();
  });

  it('is hidden without workflows.manage', async () => {
    permissions = ['settings.manage', 'documents.view'];
    render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('tab', { name: 'Document types' });
    expect(screen.queryByRole('tab', { name: 'Required documents' })).not.toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('shows the tabs and names in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/settings') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'المستندات المطلوبة' }));
    expect(await screen.findByText('فاتورة تجارية')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'أنواع المستندات' })).toBeInTheDocument();
  });
});
