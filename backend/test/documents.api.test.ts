import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser, JWT_SECRET, provision, signIn, startApi, type TestApi } from './api-helpers';

// ── fixtures: real file signatures, tiny bodies ──
const pdf = (text = 'hello') => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${text}\n%%EOF\n`);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const docx = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]);
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('documents API', () => {
  let api: TestApi;
  let A: string;
  let B: string;
  let officer: string; // upload + view, no review / delete
  let manager: string; // review + delete
  let viewer: string;
  let fileA: string;
  let fileB: string;
  let tenantAId: string;
  let invoiceType: string;
  let packingType: string;

  const ok = async (p: any) => {
    const res = await p;
    if (res.status >= 300) throw new Error(`unexpected ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data;
  };
  const upload = (token: string, fileId: string, buf: Buffer, filename = 'invoice.pdf', typeId = invoiceType, extra: Record<string, string> = {}) => {
    let r = api.req('post', `/clearance-files/${fileId}/documents`, token).field('documentTypeId', typeId);
    for (const [k, v] of Object.entries(extra)) r = r.field(k, v);
    return r.attach('file', buf, { filename });
  };
  const newVersion = (token: string, docId: string, buf: Buffer, filename = 'v2.pdf') =>
    api.req('post', `/documents/${docId}/versions`, token).attach('file', buf, { filename });
  const tmpFiles = () => readdirSync(join(api.storageRoot, '_tmp'));

  beforeAll(async () => {
    api = await startApi({ MAX_UPLOAD_MB: '0.05' }); // 50 KB limit keeps the oversize test cheap
    const a = await provision(api, 'docs-a', 'owner@docs-a.test');
    await provision(api, 'docs-b', 'owner@docs-b.test');
    tenantAId = a.tenantId;
    A = (await signIn(api, 'owner@docs-a.test')).accessToken;
    B = (await signIn(api, 'owner@docs-b.test')).accessToken;
    for (const [e, r] of [['officer', 'CLEARANCE_OFFICER'], ['manager', 'MANAGER'], ['viewer', 'VIEWER']] as const) await createUser(api, A, `${e}@docs-a.test`, r);
    officer = (await signIn(api, 'officer@docs-a.test')).accessToken;
    manager = (await signIn(api, 'manager@docs-a.test')).accessToken;
    viewer = (await signIn(api, 'viewer@docs-a.test')).accessToken;
    const ca = await ok(api.req('post', '/clients', A).send({ name: 'Doc Client A' }));
    const cb = await ok(api.req('post', '/clients', B).send({ name: 'Doc Client B' }));
    fileA = (await ok(api.req('post', '/clearance-files', A).send({ fileType: 'IMPORT', clientId: ca.id }))).id;
    fileB = (await ok(api.req('post', '/clearance-files', B).send({ fileType: 'IMPORT', clientId: cb.id }))).id;
    const types = await ok(api.req('get', '/document-types', A));
    invoiceType = types.find((t: any) => t.code === 'COMMERCIAL_INVOICE').id;
    packingType = types.find((t: any) => t.code === 'PACKING_LIST').id;
  });
  afterAll(async () => api.close());

  describe('uploading', () => {
    it('stores the file privately, verifies its content, and never reveals a storage path', async () => {
      const body = pdf('invoice 1');
      const res = await upload(officer, fileA, body, 'Invoice 001.pdf', invoiceType, { notes: 'first copy' });
      expect(res.status).toBe(201);
      const d = res.body.data;
      expect(d).toMatchObject({
        originalFilename: 'Invoice 001.pdf', mimeType: 'application/pdf', fileSize: body.length, checksum: sha256(body),
        versionNumber: 1, status: 'PENDING_REVIEW', notes: 'first copy', deletedAt: null,
        documentType: { code: 'COMMERCIAL_INVOICE' }, uploadedBy: { firstName: 'Emp' },
      });
      expect(Object.keys(d)).not.toContain('storageKey');
      expect(JSON.stringify(res.body)).not.toMatch(/storage|tenants\/|\.pdf-[0-9a-f]{8}|v1-/i);
      expect(d.versions).toHaveLength(1);

      // bytes are on disk under tenant/file/document, with the exact content, and nothing is left in temp
      const row = await api.prisma.document.findUniqueOrThrow({ where: { id: d.id } });
      expect(row.storageKey).toMatch(new RegExp(`^tenants/${tenantAId}/files/${fileA}/${d.id}/v1-[0-9a-f-]{36}$`));
      expect(readFileSync(join(api.storageRoot, row.storageKey)).equals(body)).toBe(true);
      expect(row.storageKey).not.toContain('Invoice');
      expect(tmpFiles()).toEqual([]);
    });

    it('records the upload on the timeline and in the audit log', async () => {
      const tl = await ok(api.req('get', `/clearance-files/${fileA}/timeline`, A));
      expect(tl.some((t: any) => t.activityType === 'DOCUMENT_UPLOADED' && t.description.includes('Invoice 001.pdf'))).toBe(true);
      const audit = await api.prisma.auditLog.findFirst({ where: { action: 'DOCUMENT_UPLOADED', tenantId: tenantAId } });
      expect(audit).not.toBeNull();
      expect(JSON.stringify(audit)).not.toContain('tenants/');
    });

    it('keeps Arabic file names intact and sanitises dangerous ones', async () => {
      const arabic = await ok(upload(officer, fileA, pdf('ar'), 'فاتورة تجارية.pdf', packingType));
      expect(arabic.originalFilename).toBe('فاتورة تجارية.pdf');
      const dangerous = await ok(upload(officer, fileA, pdf('d'), '..\\..\\evil"name<>.pdf', packingType));
      expect(dangerous.originalFilename).not.toMatch(/[\\/"<>]/);
      expect(dangerous.originalFilename.endsWith('.pdf')).toBe(true);
    });

    it('determines the type from the bytes, not from the name or declared type', async () => {
      const cases: [string, Buffer, number, string?][] = [
        ['script.exe', Buffer.from('MZ\x90\x00\x03\x00\x00\x00 fake exe'), 415, 'UNSUPPORTED_FILE_TYPE'],
        ['page.html', Buffer.from('<html><script>alert(1)</script></html>'), 415, 'UNSUPPORTED_FILE_TYPE'],
        ['image.svg', Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'), 415, 'UNSUPPORTED_FILE_TYPE'],
        ['fake.pdf', Buffer.from('<html>not really a pdf</html>'), 415, 'UNSUPPORTED_FILE_TYPE'],
        ['photo.pdf', png(), 415, 'FILE_TYPE_MISMATCH'], // PNG bytes pretending to be a PDF
        ['report.png', pdf(), 415, 'FILE_TYPE_MISMATCH'],
        ['noext', pdf(), 415, 'FILE_TYPE_MISMATCH'],
        ['archive.zip', docx(), 415, 'FILE_TYPE_MISMATCH'],
        ['binary.pdf', Buffer.from([0, 1, 2, 3, 0, 0, 5]), 415, 'UNSUPPORTED_FILE_TYPE'],
      ];
      for (const [name, buf, status, code] of cases) {
        const res = await upload(officer, fileA, buf, name);
        expect(res.status, name).toBe(status);
        expect(res.body.error.code, name).toBe(code);
      }
      expect(tmpFiles()).toEqual([]); // every rejected upload cleaned up its temp file
    });

    it('accepts the supported formats and stores the derived MIME type', async () => {
      const csv = await ok(upload(officer, fileA, Buffer.from('a,b,c\n1,2,3\n'), 'data.csv', packingType));
      expect(csv.mimeType).toBe('text/csv');
      const word = await ok(upload(officer, fileA, docx(), 'Letter.DOCX', packingType));
      expect(word.mimeType).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      const img = await ok(upload(officer, fileA, png(), 'scan.png', packingType));
      expect(img.mimeType).toBe('image/png');
      const jpg = await ok(upload(officer, fileA, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]), 'photo.JPEG', packingType));
      expect(jpg.mimeType).toBe('image/jpeg');
      expect(jpg.originalFilename).toBe('photo.JPEG');
    });

    it('rejects empty, oversized and malformed uploads without leaving files behind', async () => {
      const empty = await upload(officer, fileA, Buffer.alloc(0), 'empty.pdf');
      expect(empty.body.error.code).toBe('EMPTY_FILE');
      const big = await upload(officer, fileA, Buffer.concat([pdf(), Buffer.alloc(60 * 1024, 1)]), 'big.pdf');
      expect(big.status).toBe(413);
      expect(big.body.error.code).toBe('FILE_TOO_LARGE');
      const noFile = await api.req('post', `/clearance-files/${fileA}/documents`, officer).field('documentTypeId', invoiceType);
      expect(noFile.status).toBe(400);
      expect(noFile.body.error.code).toBe('FILE_REQUIRED');
      const wrongField = await api.req('post', `/clearance-files/${fileA}/documents`, officer)
        .field('documentTypeId', invoiceType).attach('document', pdf(), 'x.pdf');
      expect(wrongField.body.error.code).toBe('UNEXPECTED_FILE_FIELD');
      const json = await api.req('post', `/clearance-files/${fileA}/documents`, officer).send({ documentTypeId: invoiceType });
      expect(json.body.error.code).toBe('MULTIPART_REQUIRED');
      expect(tmpFiles()).toEqual([]);
    });

    it('validates the document type', async () => {
      expect((await upload(officer, fileA, pdf(), 'a.pdf', '00000000-0000-4000-8000-000000000000')).body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
      expect((await upload(officer, fileA, pdf(), 'a.pdf', 'not-a-uuid')).status).toBe(400);
      expect((await api.req('post', `/clearance-files/${fileA}/documents`, officer).attach('file', pdf(), 'a.pdf')).status).toBe(400);
      expect(tmpFiles()).toEqual([]);
    });

    it('does not create a document row or keep bytes when the file does not exist', async () => {
      const before = await api.prisma.document.count();
      const res = await upload(A, '00000000-0000-4000-8000-000000000000', pdf());
      expect(res.status).toBe(404);
      expect(await api.prisma.document.count()).toBe(before);
      expect(tmpFiles()).toEqual([]);
    });

    it('requires the upload permission', async () => {
      expect((await upload(viewer, fileA, pdf())).status).toBe(403);
      expect(tmpFiles()).toEqual([]); // the parser never ran for a forbidden request
      expect((await api.req('post', `/clearance-files/${fileA}/documents`).attach('file', pdf(), 'a.pdf')).status).toBe(401);
    });
  });

  describe('versions', () => {
    let doc: any;
    const v1 = pdf('version one');
    const v2 = pdf('version two — revised');

    beforeAll(async () => { doc = await ok(upload(officer, fileA, v1, 'contract.pdf', invoiceType)); });

    it('keeps every version and makes the newest current, resetting the review status', async () => {
      await ok(api.req('patch', `/documents/${doc.id}/status`, manager).send({ status: 'APPROVED' }));
      const updated = await ok(newVersion(officer, doc.id, v2, 'contract-final.pdf'));
      expect(updated).toMatchObject({ versionNumber: 2, originalFilename: 'contract-final.pdf', checksum: sha256(v2), status: 'PENDING_REVIEW' });
      expect(updated.versions.map((v: any) => [v.versionNumber, v.originalFilename])).toEqual([[2, 'contract-final.pdf'], [1, 'contract.pdf']]);
      expect(updated.versions[1].checksum).toBe(sha256(v1));
    });

    it('serves old and current versions byte-for-byte', async () => {
      const cur = await api.req('get', `/documents/${doc.id}/download`, A).buffer(true).parse(binary);
      expect((cur.body as Buffer).equals(v2)).toBe(true);
      const old = await api.req('get', `/documents/${doc.id}/download?version=1`, A).buffer(true).parse(binary);
      expect((old.body as Buffer).equals(v1)).toBe(true);
      expect((await api.req('get', `/documents/${doc.id}/download?version=9`, A)).body.error.code).toBe('DOCUMENT_VERSION_NOT_FOUND');
    });

    it('validates the new version like any upload and logs it', async () => {
      expect((await newVersion(officer, doc.id, png(), 'x.pdf')).body.error.code).toBe('FILE_TYPE_MISMATCH');
      expect((await api.req('post', `/documents/${doc.id}/versions`, officer)).status).toBe(400);
      const tl = await ok(api.req('get', `/clearance-files/${fileA}/timeline?limit=50`, A));
      expect(tl.some((t: any) => t.activityType === 'DOCUMENT_VERSION_ADDED' && t.description.includes('v2'))).toBe(true);
      expect(tmpFiles()).toEqual([]);
    });

    it('leaves exactly one set of bytes per version on disk', async () => {
      const versions = await api.prisma.documentVersion.findMany({ where: { documentId: doc.id } });
      expect(versions).toHaveLength(2);
      for (const v of versions) expect(existsSync(join(api.storageRoot, v.storageKey))).toBe(true);
      expect(new Set(versions.map((v) => v.storageKey)).size).toBe(2);
    });
  });

  describe('downloading', () => {
    let doc: any;
    const body = pdf('download me');
    beforeAll(async () => { doc = await ok(upload(officer, fileA, body, 'فاتورة.pdf', invoiceType)); });

    it('streams with safe headers and a UTF-8 file name', async () => {
      const res = await api.req('get', `/documents/${doc.id}/download`, viewer).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(body)).toBe(true);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['content-length']).toBe(String(body.length));
      expect(res.headers['content-disposition']).toMatch(/^attachment; filename="_+\.pdf"; filename\*=UTF-8''%D9%81/);
    });

    it('allows inline viewing only for formats without active content, sandboxed', async () => {
      const inline = await api.req('get', `/documents/${doc.id}/download?disposition=inline`, A).buffer(true).parse(binary);
      expect(inline.headers['content-disposition']).toMatch(/^inline;/);
      expect(inline.headers['content-security-policy']).toContain('sandbox');
      const word = await ok(upload(officer, fileA, docx(), 'letter.docx', packingType));
      const forced = await api.req('get', `/documents/${word.id}/download?disposition=inline`, A).buffer(true).parse(binary);
      expect(forced.headers['content-disposition']).toMatch(/^attachment;/); // docx is never shown inline
    });

    it('requires authentication and the view permission, and audits each download', async () => {
      expect((await api.req('get', `/documents/${doc.id}/download`)).status).toBe(401);
      const logs = await api.prisma.auditLog.count({ where: { action: 'DOCUMENT_DOWNLOADED', entityId: doc.id } });
      expect(logs).toBeGreaterThanOrEqual(2);
    });

    it('reports a clear error when the stored file has gone missing', async () => {
      const gone = await ok(upload(officer, fileA, pdf('gone'), 'gone.pdf', packingType));
      const row = await api.prisma.document.findUniqueOrThrow({ where: { id: gone.id } });
      const { rmSync } = await import('node:fs');
      rmSync(join(api.storageRoot, row.storageKey));
      const res = await api.req('get', `/documents/${gone.id}/download`, A);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('DOCUMENT_FILE_MISSING');
    });
  });

  describe('signed download links', () => {
    let doc: any;
    const body = pdf('link content');
    beforeAll(async () => { doc = await ok(upload(officer, fileA, body, 'linked.pdf', invoiceType)); });

    it('issues a short-lived link that downloads without an Authorization header', async () => {
      const link = await ok(api.req('get', `/documents/${doc.id}/link`, viewer));
      expect(link.url).toMatch(/^\/api\/v1\/downloads\/.+/);
      expect(link.expiresInSeconds).toBe(60);
      expect(link.url).not.toContain(doc.id); // the token is opaque, not a guessable id
      const res = await api.http.get(link.url).buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect((res.body as Buffer).equals(body)).toBe(true);
    });

    it('rejects tampered, expired, and wrongly-typed tokens', async () => {
      const link = await ok(api.req('get', `/documents/${doc.id}/link`, A));
      const token = link.url.split('/').pop() as string;
      expect((await api.http.get(`/api/v1/downloads/${token.slice(0, -3)}abc`)).status).toBe(401);
      expect((await api.http.get('/api/v1/downloads/garbage')).body.error.code).toBe('INVALID_DOWNLOAD_LINK');

      const me = (await ok(api.req('get', '/auth/me', A))).user.id;
      const expired = new JwtService().sign(
        { sub: doc.id, tid: tenantAId, uid: me, ver: 1, disp: 'attachment' },
        { secret: JWT_SECRET, issuer: 'clearport', audience: 'clearport-download', expiresIn: -10 },
      );
      expect((await api.http.get(`/api/v1/downloads/${expired}`)).status).toBe(401);

      // an access token cannot be used as a download token, and vice versa
      expect((await api.http.get(`/api/v1/downloads/${A}`)).status).toBe(401);
      expect((await api.req('get', '/auth/me', token)).status).toBe(401);
    });

    it('stops working when the requester loses access, and never serves voided documents', async () => {
      const u = await createUser(api, A, 'temp@docs-a.test', 'VIEWER');
      const t = (await signIn(api, 'temp@docs-a.test')).accessToken;
      const link = await ok(api.req('get', `/documents/${doc.id}/link`, t));
      expect((await api.http.get(link.url)).status).toBe(200);
      await api.req('patch', `/users/${u.id}/status`, A).send({ isActive: false });
      expect((await api.http.get(link.url)).status).toBe(401);

      const other = await ok(upload(officer, fileA, pdf('to void'), 'void-me.pdf', packingType));
      const l2 = await ok(api.req('get', `/documents/${other.id}/link`, A));
      await api.req('delete', `/documents/${other.id}`, manager);
      expect((await api.http.get(l2.url)).status).toBe(404);
      expect((await api.req('get', `/documents/${other.id}/link`, A)).status).toBe(404);
    });

    it('cannot be issued for another office\'s document', async () => {
      const bDoc = await ok(upload(B, fileB, pdf('b secret'), 'b.pdf', (await ok(api.req('get', '/document-types', B))).find((t: any) => t.code === 'COMMERCIAL_INVOICE').id));
      expect((await api.req('get', `/documents/${bDoc.id}/link`, A)).status).toBe(404);
      expect((await api.req('get', `/documents/${bDoc.id}/download`, A)).status).toBe(404);
    });
  });

  describe('review, void and closed files', () => {
    let doc: any;
    beforeAll(async () => { doc = await ok(upload(officer, fileA, pdf('review me'), 'review.pdf', packingType)); });

    it('lets reviewers approve and reject (a rejection needs a reason); uploaders cannot review', async () => {
      expect((await api.req('patch', `/documents/${doc.id}/status`, officer).send({ status: 'APPROVED' })).status).toBe(403);
      expect((await api.req('patch', `/documents/${doc.id}/status`, manager).send({ status: 'REJECTED' })).body.error.code).toBe('REJECTION_NOTE_REQUIRED');
      const rej = await ok(api.req('patch', `/documents/${doc.id}/status`, manager).send({ status: 'REJECTED', note: 'Blurry scan' }));
      expect(rej.status).toBe('REJECTED');
      const ap = await ok(api.req('patch', `/documents/${doc.id}/status`, manager).send({ status: 'APPROVED' }));
      expect(ap.status).toBe('APPROVED');
      expect((await api.req('patch', `/documents/${doc.id}/status`, manager).send({ status: 'VOID' })).status).toBe(400); // void has its own endpoint
      const tl = await ok(api.req('get', `/clearance-files/${fileA}/timeline?limit=100`, A));
      expect(tl.some((t: any) => t.description.includes('rejected: Blurry scan'))).toBe(true);
    });

    it('voids instead of deleting: record and bytes stay, but it disappears from lists and is frozen', async () => {
      expect((await api.req('delete', `/documents/${doc.id}`, officer)).status).toBe(403);
      expect((await api.req('delete', `/documents/${doc.id}`, manager)).status).toBe(204);
      expect((await api.req('delete', `/documents/${doc.id}`, manager)).status).toBe(204); // idempotent
      const row = await api.prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row.status).toBe('VOID');
      expect(row.deletedAt).not.toBeNull();
      expect(existsSync(join(api.storageRoot, row.storageKey))).toBe(true);
      const list = await ok(api.req('get', `/clearance-files/${fileA}/documents?limit=100`, A));
      expect(list.some((d: any) => d.id === doc.id)).toBe(false);
      const withVoid = await ok(api.req('get', `/clearance-files/${fileA}/documents?includeVoid=true&limit=100`, A));
      expect(withVoid.some((d: any) => d.id === doc.id && d.status === 'VOID')).toBe(true);
      expect((await api.req('patch', `/documents/${doc.id}/status`, manager).send({ status: 'APPROVED' })).body.error.code).toBe('DOCUMENT_VOID');
      expect((await newVersion(officer, doc.id, pdf())).body.error.code).toBe('DOCUMENT_VOID');
      expect((await api.req('get', `/documents/${doc.id}/download`, A)).status).toBe(404);
    });

    it('makes documents of a closed file read-only', async () => {
      const f = await ok(api.req('post', '/clearance-files', A).send({ fileType: 'IMPORT', clientId: (await api.prisma.client.findFirstOrThrow({ where: { tenantId: tenantAId } })).id }));
      const d = await ok(upload(officer, f.id, pdf('closed'), 'c.pdf'));
      await api.prisma.clearanceFile.update({ where: { id: f.id }, data: { status: 'CLOSED', closedAt: new Date() } });
      for (const res of await Promise.all([
        upload(officer, f.id, pdf(), 'n.pdf'), newVersion(officer, d.id, pdf()),
        api.req('patch', `/documents/${d.id}/status`, manager).send({ status: 'APPROVED' }),
        api.req('delete', `/documents/${d.id}`, manager),
      ])) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('FILE_NOT_EDITABLE');
      }
      expect((await api.req('get', `/documents/${d.id}/download`, A)).status).toBe(200); // still readable
      expect(tmpFiles()).toEqual([]);
    });
  });

  describe('listing and searching', () => {
    it('lists, filters and searches documents across files', async () => {
      const all = await api.req('get', '/documents?limit=100', A);
      expect(all.body.meta.total).toBeGreaterThan(5);
      expect(all.body.data[0].clearanceFile.fileNumber).toMatch(/^IMP-/);
      const byName = await ok(api.req('get', '/documents?search=contract-final', A));
      expect(byName.map((d: any) => d.originalFilename)).toEqual(['contract-final.pdf']);
      expect((await ok(api.req('get', '/documents?search=%25', A)))).toEqual([]);
      const byType = await ok(api.req('get', `/documents?documentTypeId=${packingType}&limit=100`, A));
      expect(byType.every((d: any) => d.documentType.code === 'PACKING_LIST')).toBe(true);
      const approved = await ok(api.req('get', '/documents?status=APPROVED&limit=100', A));
      expect(approved.every((d: any) => d.status === 'APPROVED')).toBe(true);
    });
  });

  describe('office isolation', () => {
    let bDoc: any;
    let bType: string;
    beforeAll(async () => {
      bType = (await ok(api.req('get', '/document-types', B))).find((t: any) => t.code === 'COMMERCIAL_INVOICE').id;
      bDoc = await ok(upload(B, fileB, pdf('only b'), 'b-only.pdf', bType));
    });

    it('answers 404 on every document route for a foreign id or file', async () => {
      const attempts = [
        api.req('get', `/documents/${bDoc.id}`, A), api.req('get', `/documents/${bDoc.id}/download`, A),
        api.req('get', `/documents/${bDoc.id}/link`, A), newVersion(A, bDoc.id, pdf()),
        api.req('patch', `/documents/${bDoc.id}/status`, A).send({ status: 'APPROVED' }), api.req('delete', `/documents/${bDoc.id}`, A),
        upload(A, fileB, pdf('planted'), 'x.pdf'), api.req('get', `/clearance-files/${fileB}/documents`, A),
        api.req('get', `/clearance-files/${fileB}/document-requirements`, A),
      ];
      for (const res of await Promise.all(attempts)) expect(res.status).toBe(404);
      expect((await ok(api.req('get', `/documents/${bDoc.id}`, B))).status).toBe('PENDING_REVIEW');
      expect(tmpFiles()).toEqual([]);
    });

    it('never lists or finds another office\'s documents', async () => {
      expect((await ok(api.req('get', '/documents?search=b-only', A)))).toEqual([]);
      expect((await ok(api.req('get', '/documents?limit=100', A))).some((d: any) => d.id === bDoc.id)).toBe(false);
    });

    it('rejects a document type that belongs to another office', async () => {
      const custom = await ok(api.req('post', '/document-types', B).send({ code: 'B_PRIVATE', nameEn: 'B private', nameAr: 'خاص' }));
      expect((await upload(A, fileA, pdf(), 'a.pdf', custom.id)).body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND');
      expect((await ok(api.req('get', '/document-types', A))).some((t: any) => t.code === 'B_PRIVATE')).toBe(false);
    });

    it('stores each office\'s bytes under its own tenant directory', async () => {
      const a = await api.prisma.document.findFirstOrThrow({ where: { tenantId: tenantAId } });
      const b = await api.prisma.document.findUniqueOrThrow({ where: { id: bDoc.id } });
      expect(a.storageKey.startsWith(`tenants/${tenantAId}/`)).toBe(true);
      expect(b.storageKey.startsWith(`tenants/${b.tenantId}/`)).toBe(true);
      expect(b.tenantId).not.toBe(tenantAId);
    });
  });

  describe('document types', () => {
    it('lists the seeded system types in both languages', async () => {
      const types = await ok(api.req('get', '/document-types', viewer));
      const codes = types.map((t: any) => t.code);
      expect(codes).toEqual(expect.arrayContaining(['COMMERCIAL_INVOICE', 'PACKING_LIST', 'BILL_OF_LADING', 'CERTIFICATE_OF_ORIGIN', 'DELIVERY_ORDER', 'CUSTOMS_DECLARATION', 'IMPORT_PERMIT', 'PAYMENT_PROOF', 'INSPECTION_REPORT', 'OTHER']));
      expect(types.find((t: any) => t.code === 'BILL_OF_LADING')).toMatchObject({ nameEn: 'Bill of Lading', nameAr: 'بوليصة الشحن' });
    });

    it('lets administrators add custom types but never alter or shadow system ones', async () => {
      const created = await api.req('post', '/document-types', A).send({ code: 'fumigation_cert', nameEn: 'Fumigation certificate', nameAr: 'شهادة تبخير' });
      expect(created.status).toBe(201);
      expect(created.body.data.code).toBe('FUMIGATION_CERT');
      expect((await api.req('post', '/document-types', A).send({ code: 'FUMIGATION_CERT', nameEn: 'x', nameAr: 'x' })).body.error.code).toBe('DOCUMENT_TYPE_CODE_TAKEN');
      expect((await api.req('post', '/document-types', A).send({ code: 'PACKING_LIST', nameEn: 'x', nameAr: 'x' })).body.error.code).toBe('DOCUMENT_TYPE_CODE_RESERVED');
      expect((await api.req('patch', `/document-types/${packingType}`, A).send({ nameEn: 'hacked' })).body.error.code).toBe('SYSTEM_DOCUMENT_TYPE_READONLY');
      expect((await api.req('patch', `/document-types/${created.body.data.id}`, A).send({ isActive: false })).body.data.isActive).toBe(false);
      expect((await upload(officer, fileA, pdf(), 'f.pdf', created.body.data.id)).body.error.code).toBe('DOCUMENT_TYPE_NOT_FOUND'); // inactive
      expect((await api.req('post', '/document-types', manager).send({ code: 'NOPE', nameEn: 'x', nameAr: 'x' })).status).toBe(403);
    });
  });
});

/** supertest: collect the body as a Buffer. */
function binary(res: any, cb: (err: Error | null, body: Buffer) => void) {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
