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
const T_INVOICE = { id: 'dt1', code: 'COMMERCIAL_INVOICE', nameEn: 'Commercial invoice', nameAr: 'فاتورة تجارية', isActive: true };
const T_BL = { id: 'dt2', code: 'BILL_OF_LADING', nameEn: 'Bill of lading', nameAr: 'بوليصة الشحن', isActive: true };
const DOC = (over: Record<string, unknown> = {}) => ({
  id: 'd1', clearanceFileId: 'f1', documentType: T_INVOICE, originalFilename: 'فاتورة-123.pdf', mimeType: 'application/pdf', fileSize: 1_500_000, versionNumber: 2,
  status: 'PENDING_REVIEW', notes: 'first batch', uploadedBy: { id: 'u1', firstName: 'Sara', lastName: 'Khoury' }, uploadedAt: '2026-11-03T10:00:00.000+00:00', deletedAt: null, ...over,
});
const CHECK = [
  { requirementId: 'r1', documentType: T_INVOICE, isRequired: true, requiredBeforeStage: null, state: 'UPLOADED', satisfied: true, documentIds: ['d1'] },
  { requirementId: 'r2', documentType: T_BL, isRequired: true, requiredBeforeStage: { id: 's2', code: 'CUSTOMS', nameEn: 'Customs declaration', nameAr: null }, state: 'MISSING', satisfied: false, documentIds: [] },
];

const ALL = ['clearance_files.view', 'documents.view', 'documents.upload', 'documents.review', 'documents.delete'];
let permissions: string[];
let fileStatus: string;
let docs: ReturnType<typeof DOC>[];
let calls: { method: string; path: string; body: any }[];
let failNext: Record<string, Response>;

beforeEach(() => {
  permissions = [...ALL];
  fileStatus = 'OPEN';
  docs = [DOC()];
  calls = [];
  failNext = {};
  setLocale('en');
  tokens.set({ accessToken: '', refreshToken: 'S'.repeat(40) });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const path = url.replace('/api/v1', '').split('?')[0];
    let body: any;
    if (init.body instanceof FormData) body = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, v instanceof File ? { file: v.name, size: v.size } : v]));
    else if (init.body) body = JSON.parse(String(init.body));
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    if (failNext[key]) { const r = failNext[key]; delete failNext[key]; return r; }
    if (path === '/auth/refresh') return ok({ accessToken: 'A', refreshToken: 'R'.repeat(40) });
    if (path === '/auth/me') return ok({
      user: { id: 'u1', email: 'a@b.c', firstName: 'Sara', lastName: 'Khoury' }, tenant: { id: 't', slug: 'x', name: 'X', defaultCurrency: 'USD', timezone: 'Asia/Beirut', locale: 'en' },
      branch: null, roles: [], permissions, availableTenants: [],
    });
    if (path === '/clearance-files/f1' && method === 'GET') return ok(FILE(fileStatus));
    if (path.endsWith('/transitions')) return ok({ currentStage: null, status: fileStatus, transitions: [] });
    if (path.endsWith('/summary')) return ok({ counts: { shipments: 0, containers: 0, goodsLines: 0, documents: docs.length, openTasks: 0 } });
    if (path === '/clearance-files/f1/document-requirements') return ok(CHECK);
    if (path === '/clearance-files/f1/documents' && method === 'GET') return ok(docs, { page: 1, limit: 20, total: docs.length });
    if (path === '/document-types') return ok([T_INVOICE, T_BL, { id: 'dt3', code: 'OLD', nameEn: 'Retired type', nameAr: 'قديم', isActive: false }]);
    if (path === '/documents/d1/download') {
      return new Response(new Blob(['%PDF-1.4 test']), { status: 200, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="_-123.pdf"; filename*=UTF-8''${encodeURIComponent('فاتورة-123.pdf')}` } });
    }
    if (method === 'POST' || method === 'PATCH') return ok({ id: 'd2' });
    if (method === 'DELETE') return res(204, null);
    return fail(404, 'NOT_FOUND', 'no route');
  }));
});

const open = async () => {
  render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('tab', { name: 'Documents' }));
  return user;
};
const sent = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const openUploadForm = async (user: ReturnType<typeof userEvent.setup>) => {
  const header = (await screen.findByRole('heading', { name: 'Documents', level: 2 })).parentElement!;
  await user.click(within(header).getByRole('button', { name: 'Upload' }));
  return (await screen.findByRole('heading', { name: 'Upload a document' })).closest('form')!;
};
const pdf = (name = 'invoice.pdf') => new File(['%PDF-1.4 hello'], name, { type: 'application/pdf' });

describe('checklist', () => {
  it('shows what is missing and for which stage', async () => {
    await open();
    expect(await screen.findByText('Missing: 1')).toBeInTheDocument();
    const missing = screen.getByText('Bill of lading').closest('li')!;
    expect(missing).toHaveTextContent('needed before Customs declaration');
    expect(within(missing).getByText('Missing')).toBeInTheDocument();
    expect(within(screen.getAllByText('Commercial invoice')[0].closest('li')!).getByText('Uploaded')).toBeInTheDocument();
  });

  it('offers to upload a missing document with its type already chosen', async () => {
    const user = await open();
    const row = (await screen.findByText('Bill of lading')).closest('li')!;
    await user.click(within(row).getByRole('button', { name: 'Upload' }));
    expect(await screen.findByLabelText('Document type')).toHaveValue('dt2');
  });
});

describe('documents list', () => {
  it('shows the documents with version, size and uploader', async () => {
    await open();
    const row = (await screen.findByText('فاتورة-123.pdf')).closest('tr')!;
    expect(within(row).getByText('v2')).toBeInTheDocument();
    expect(within(row).getByText('1.4 MB')).toBeInTheDocument();
    expect(within(row).getByText('Pending review')).toBeInTheDocument();
    expect(within(row).getByText(/Sara Khoury/)).toBeInTheDocument();
  });

  it('downloads with the real file name, including Arabic names', async () => {
    const created: Blob[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { (created as any).name = this.download; });
    (URL as any).createObjectURL = vi.fn((b: Blob) => { created.push(b); return 'blob:x'; });
    (URL as any).revokeObjectURL = vi.fn();
    const user = await open();
    await user.click(await screen.findByRole('button', { name: /Download فاتورة-123.pdf/ }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect((created as any).name).toBe('فاتورة-123.pdf');
    expect(created).toHaveLength(1);
    click.mockRestore();
  });
});

describe('uploading', () => {
  it('asks for a type and a file, then sends them as a multipart form', async () => {
    const user = await open();
    const form = await openUploadForm(user);
    await user.click(within(form).getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('Choose the type of document')).toBeInTheDocument();
    expect(screen.getByText('Choose a file')).toBeInTheDocument();
    expect(sent('POST', '/clearance-files/f1/documents')).toHaveLength(0);

    expect(within(screen.getByLabelText('Document type')).queryByText('Retired type')).not.toBeInTheDocument(); // inactive types are not offered
    await user.selectOptions(screen.getByLabelText('Document type'), 'dt1');
    await user.upload(screen.getByLabelText('File'), pdf());
    await user.type(screen.getByLabelText('Notes'), 'original');
    await user.click(within(form).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(sent('POST', '/clearance-files/f1/documents')).toHaveLength(1));
    expect(sent('POST', '/clearance-files/f1/documents')[0].body).toEqual({ documentTypeId: 'dt1', notes: 'original', file: { file: 'invoice.pdf', size: 14 } });
  });

  it('shows the server message when a file is refused', async () => {
    failNext['POST /clearance-files/f1/documents'] = fail(422, 'EXTENSION_MISMATCH', 'The file content does not match its extension');
    const user = await open();
    const form = await openUploadForm(user);
    await user.selectOptions(screen.getByLabelText('Document type'), 'dt1');
    await user.upload(screen.getByLabelText('File'), pdf('fake.pdf'));
    await user.click(within(form).getByRole('button', { name: 'Upload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('does not match its extension');
  });

  it('uploads a new version of a document', async () => {
    const user = await open();
    await screen.findByText('فاتورة-123.pdf');
    await user.upload(screen.getByLabelText(/New version/), pdf('v3.pdf'));
    await waitFor(() => expect(sent('POST', '/documents/d1/versions')).toHaveLength(1));
    expect(sent('POST', '/documents/d1/versions')[0].body).toEqual({ file: { file: 'v3.pdf', size: 14 } });
  });
});

describe('review and void', () => {
  it('approves with one click', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: /Approve فاتورة/ }));
    await waitFor(() => expect(sent('PATCH', '/documents/d1/status')).toHaveLength(1));
    expect(sent('PATCH', '/documents/d1/status')[0].body).toEqual({ status: 'APPROVED' });
  });

  it('rejects only with a reason', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: /Reject فاتورة/ }));
    const confirm = screen.getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Why is it rejected?'), 'Blurry scan');
    await user.click(confirm);
    await waitFor(() => expect(sent('PATCH', '/documents/d1/status')[0].body).toEqual({ status: 'REJECTED', note: 'Blurry scan' }));
  });

  it('voids only after a confirmation', async () => {
    const user = await open();
    await user.click(await screen.findByRole('button', { name: /Void فاتورة/ }));
    expect(sent('DELETE', '/documents/d1')).toHaveLength(0);
    await user.click(within(screen.getByText(/Void this document\?/).parentElement!).getByRole('button', { name: 'Void' }));
    await waitFor(() => expect(sent('DELETE', '/documents/d1')).toHaveLength(1));
  });

  it('shows the server refusal next to the document', async () => {
    failNext['PATCH /documents/d1/status'] = fail(409, 'DOCUMENT_VOID', 'A voided document cannot be reviewed');
    const user = await open();
    await user.click(await screen.findByRole('button', { name: /Approve فاتورة/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A voided document cannot be reviewed');
  });
});

describe('permissions and state', () => {
  it('has no documents tab without documents.view', async () => {
    permissions = ['clearance_files.view'];
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByRole('heading', { name: 'IMP-2026-00001' });
    expect(screen.queryByRole('tab', { name: 'Documents' })).not.toBeInTheDocument();
  });

  it('can only view and download when the user may not upload, review or delete', async () => {
    permissions = ['clearance_files.view', 'documents.view'];
    await open();
    await screen.findByText('فاتورة-123.pdf');
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
    for (const name of [/Approve/, /Reject/, /Void/, /New version/, /^Upload$/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('is read-only on a closed file and says why', async () => {
    fileStatus = 'CLOSED';
    await open();
    await screen.findByText('فاتورة-123.pdf');
    expect(screen.getByText(/closed or cancelled/)).toBeInTheDocument();
    for (const name of [/Approve/, /Reject/, /Void/, /New version/, /^Upload$/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download/ })).toBeInTheDocument();
  });
});

describe('Arabic', () => {
  it('translates the tab and shows document type names in Arabic', async () => {
    setLocale('ar');
    render(<App router={createTestRouter('/files/f1') as any} client={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'المستندات' }));
    expect(await screen.findByText('المستندات المطلوبة')).toBeInTheDocument();
    expect(screen.getAllByText('بوليصة الشحن').length).toBeGreaterThan(0);
    expect(screen.getByText('بانتظار المراجعة')).toBeInTheDocument();
  });
});
