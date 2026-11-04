import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { badRequest, conflict, DomainError, notFound, unauthorized, unprocessable } from '../../common/errors';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { ENV, type Env } from '../../config/env';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { requireTenant, runWithTenant } from '../../database/tenant-context';
import { detectFile, safeFilename } from '../../infrastructure/storage/file-signature';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { TokenService } from '../auth/token.service';
import { ActivityService } from '../clearance-files/activity.service';
import { FilesService } from '../clearance-files/files.service';
import type { documentListQuerySchema, documentStatusSchema, UploadFields } from './documents.schemas';

const typeSelect = { id: true, code: true, nameEn: true, nameAr: true } as const;
const INLINE_SAFE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif']);
const DOC_SORT = ['uploadedAt', 'originalFilename', 'status'] as const;

/**
 * Browsers send multipart filenames as raw UTF-8 bytes, but the parser decodes them as latin1, which
 * garbles Arabic names. Re-decode when that round-trips cleanly.
 */
export function fixFilenameEncoding(name: string): string {
  if (/^[\x00-\x7f]*$/.test(name)) return name;
  const recovered = Buffer.from(name, 'latin1').toString('utf8');
  return recovered.includes('�') ? name : recovered;
}

export interface PreparedDownload {
  key: string;
  mimeType: string;
  filename: string;
  size: number;
  disposition: 'attachment' | 'inline';
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LocalStorageService) private readonly storage: LocalStorageService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ───────────────────────────── upload ─────────────────────────────

  async upload(auth: AuthContext, fileId: string, fields: UploadFields, upload: Express.Multer.File | undefined, meta: RequestMeta) {
    if (!upload) throw badRequest('FILE_REQUIRED', 'Attach the document in the "file" field');
    let committedKey: string | undefined;
    try {
      const file = await this.files.require(fileId);
      this.files.assertEditable(file);
      const type = await this.db.client.documentType.findUnique({ where: { id: fields.documentTypeId } });
      if (!type || !type.isActive) throw unprocessable('DOCUMENT_TYPE_NOT_FOUND', 'Document type not found');

      const documentId = randomUUID();
      const stored = await this.ingest(upload, auth.tenantId, fileId, documentId, 1);
      committedKey = stored.key;

      await this.db.client.$transaction(async (tx) => {
        await tx.document.create({
          data: {
            id: documentId, clearanceFileId: fileId, documentTypeId: type.id, originalFilename: stored.originalFilename,
            storageKey: stored.key, mimeType: stored.mimeType, fileSize: BigInt(stored.size), checksum: stored.checksum,
            versionNumber: 1, uploadedBy: auth.userId, status: 'PENDING_REVIEW', notes: fields.notes ?? null,
          } as any,
        });
        await tx.documentVersion.create({
          data: {
            documentId, versionNumber: 1, storageKey: stored.key, originalFilename: stored.originalFilename,
            mimeType: stored.mimeType, fileSize: BigInt(stored.size), checksum: stored.checksum, uploadedBy: auth.userId,
          } as any,
        });
        await this.activity.log(fileId, auth.userId, 'DOCUMENT_UPLOADED',
          `${type.nameEn} uploaded: ${stored.originalFilename}`, { documentId, documentType: type.code }, tx);
      });
      await this.audit.record({
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_UPLOADED', entityType: 'Document',
        entityId: documentId, after: { clearanceFileId: fileId, type: type.code, filename: stored.originalFilename, size: stored.size, checksum: stored.checksum },
        ip: meta.ip, userAgent: meta.userAgent,
      });
      return await this.get(documentId);
    } catch (e) {
      if (committedKey) await this.storage.removeKey(committedKey); // no orphan bytes after a failed upload
      throw e;
    } finally {
      await this.storage.discard(upload.path);
    }
  }

  async addVersion(auth: AuthContext, documentId: string, notes: string | null | undefined, upload: Express.Multer.File | undefined, meta: RequestMeta) {
    if (!upload) throw badRequest('FILE_REQUIRED', 'Attach the document in the "file" field');
    let committedKey: string | undefined;
    try {
      const doc = await this.require(documentId);
      if (doc.deletedAt) throw conflict('DOCUMENT_VOID', 'A voided document cannot get new versions');
      this.files.assertEditable(await this.files.require(doc.clearanceFileId));

      const next = doc.versionNumber + 1;
      const stored = await this.ingest(upload, auth.tenantId, doc.clearanceFileId, doc.id, next);
      committedKey = stored.key;

      await this.db.client.$transaction(async (tx) => {
        await tx.documentVersion.create({
          data: {
            documentId: doc.id, versionNumber: next, storageKey: stored.key, originalFilename: stored.originalFilename,
            mimeType: stored.mimeType, fileSize: BigInt(stored.size), checksum: stored.checksum, uploadedBy: auth.userId,
          } as any,
        });
        // The document row always describes the CURRENT version; older versions stay in document_versions.
        await tx.document.update({
          where: { id: doc.id },
          data: {
            storageKey: stored.key, originalFilename: stored.originalFilename, mimeType: stored.mimeType,
            fileSize: BigInt(stored.size), checksum: stored.checksum, versionNumber: next, uploadedBy: auth.userId,
            uploadedAt: new Date(), status: 'PENDING_REVIEW', notes: notes ?? doc.notes,
          },
        });
        await this.activity.log(doc.clearanceFileId, auth.userId, 'DOCUMENT_VERSION_ADDED',
          `New version (v${next}) of ${doc.documentType.nameEn}: ${stored.originalFilename}`, { documentId: doc.id, version: next }, tx);
      });
      await this.audit.record({
        tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_VERSION_ADDED', entityType: 'Document',
        entityId: doc.id, before: { version: doc.versionNumber, checksum: doc.checksum },
        after: { version: next, filename: stored.originalFilename, size: stored.size, checksum: stored.checksum },
        ip: meta.ip, userAgent: meta.userAgent,
      });
      return await this.get(doc.id);
    } catch (e) {
      if (committedKey) await this.storage.removeKey(committedKey);
      throw e;
    } finally {
      await this.storage.discard(upload.path);
    }
  }

  /** Verifies what the bytes really are, fingerprints them and moves them into private storage. */
  private async ingest(upload: Express.Multer.File, tenantId: string, fileId: string, documentId: string, version: number) {
    if (upload.size === 0) throw badRequest('EMPTY_FILE', 'The uploaded file is empty');
    const original = fixFilenameEncoding(upload.originalname);
    const detected = await detectFile(upload.path, original);
    if (!detected.ok) {
      throw new DomainError(detected.reason === 'UNSUPPORTED_CONTENT' ? 'UNSUPPORTED_FILE_TYPE' : 'FILE_TYPE_MISMATCH', detected.detail, 415);
    }
    const { checksum, size } = await this.storage.fingerprint(upload.path);
    const key = this.storage.buildKey(tenantId, fileId, documentId, version);
    await this.storage.commit(upload.path, key);
    return {
      key, checksum, size, mimeType: detected.file.mimeType,
      originalFilename: safeFilename(original, detected.file.extension),
    };
  }

  // ───────────────────────────── read ─────────────────────────────

  async get(id: string) {
    const d = await this.db.client.document.findUnique({
      where: { id },
      include: { documentType: { select: typeSelect }, versions: { orderBy: { versionNumber: 'desc' } } },
    });
    if (!d) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    const users = await this.userNames([d.uploadedBy, ...d.versions.map((v) => v.uploadedBy)]);
    return {
      ...this.present(d, users),
      versions: d.versions.map((v) => ({
        versionNumber: v.versionNumber, originalFilename: v.originalFilename, mimeType: v.mimeType,
        fileSize: v.fileSize === null ? null : Number(v.fileSize), checksum: v.checksum,
        uploadedBy: users.get(v.uploadedBy) ?? null, createdAt: v.createdAt,
      })),
    };
  }

  async list(q: z.infer<typeof documentListQuerySchema>, forFileId?: string) {
    const where: any = {};
    const fileId = forFileId ?? q.clearanceFileId;
    if (fileId) where.clearanceFileId = fileId;
    if (q.documentTypeId) where.documentTypeId = q.documentTypeId;
    if (q.status) where.status = q.status;
    else if (q.includeVoid !== 'true') where.deletedAt = null;
    if (q.search) {
      where.id = { in: await searchIds(this.db.client, { table: 'documents', columns: ['originalFilename'], term: q.search, tenantId: requireTenant().tenantId }) };
    }
    const [rows, total] = await Promise.all([
      this.db.client.document.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, DOC_SORT, { uploadedAt: 'desc' }),
        include: { documentType: { select: typeSelect }, clearanceFile: { select: { id: true, fileNumber: true } } },
      }),
      this.db.client.document.count({ where }),
    ]);
    const users = await this.userNames(rows.map((r) => r.uploadedBy));
    return paginated(rows.map((r) => ({ ...this.present(r, users), clearanceFile: r.clearanceFile })), q, total);
  }

  /** Public view of a document: never includes the storage key. */
  private present(d: any, users: Map<string, { id: string; firstName: string; lastName: string }>) {
    return {
      id: d.id, clearanceFileId: d.clearanceFileId, documentType: d.documentType, originalFilename: d.originalFilename,
      mimeType: d.mimeType, fileSize: Number(d.fileSize), checksum: d.checksum, versionNumber: d.versionNumber,
      status: d.status, notes: d.notes, uploadedBy: users.get(d.uploadedBy) ?? null, uploadedAt: d.uploadedAt, deletedAt: d.deletedAt,
    };
  }

  private async userNames(ids: string[]) {
    const unique = [...new Set(ids)];
    const rows = await this.db.client.tenantUser.findMany({
      where: { userId: { in: unique } }, select: { userId: true, user: { select: { id: true, firstName: true, lastName: true } } },
    });
    return new Map(rows.map((r) => [r.userId, r.user] as const));
  }

  private async require(id: string) {
    const d = await this.db.client.document.findUnique({ where: { id }, include: { documentType: { select: typeSelect } } });
    if (!d) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    return d;
  }

  // ───────────────────────────── review and void ─────────────────────────────

  async setStatus(auth: AuthContext, id: string, input: z.infer<typeof documentStatusSchema>, meta: RequestMeta) {
    const doc = await this.require(id);
    if (doc.deletedAt) throw conflict('DOCUMENT_VOID', 'A voided document cannot be reviewed');
    this.files.assertEditable(await this.files.require(doc.clearanceFileId));
    if (input.status === 'REJECTED' && (!input.note || input.note.length < 3)) {
      throw unprocessable('REJECTION_NOTE_REQUIRED', 'Explain why the document is rejected (note)');
    }
    if (doc.status === input.status) return this.get(id);
    await this.db.client.document.update({ where: { id }, data: { status: input.status } });
    const verb = { APPROVED: 'approved', REJECTED: 'rejected', PENDING_REVIEW: 'returned to review' }[input.status];
    await this.activity.log(doc.clearanceFileId, auth.userId, `DOCUMENT_${input.status}`,
      `${doc.documentType.nameEn} ${verb}${input.note ? `: ${input.note}` : ''}`, { documentId: id, note: input.note ?? null });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_STATUS_CHANGED', entityType: 'Document',
      entityId: id, before: { status: doc.status }, after: { status: input.status, note: input.note ?? null }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  /** "Delete" = void: the record and its bytes stay (retention, audit); it stops counting everywhere. */
  async void(auth: AuthContext, id: string, meta: RequestMeta) {
    const doc = await this.require(id);
    if (doc.deletedAt) return;
    this.files.assertEditable(await this.files.require(doc.clearanceFileId));
    await this.db.client.document.update({ where: { id }, data: { deletedAt: new Date(), status: 'VOID' } });
    await this.activity.log(doc.clearanceFileId, auth.userId, 'DOCUMENT_VOIDED',
      `${doc.documentType.nameEn} voided: ${doc.originalFilename}`, { documentId: id });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_VOIDED', entityType: 'Document',
      entityId: id, before: { status: doc.status }, ip: meta.ip, userAgent: meta.userAgent,
    });
  }

  // ───────────────────────────── download ─────────────────────────────

  /** Resolves the bytes to serve (checks the file still exists) and audits the access. */
  async prepareDownload(actorUserId: string, id: string, version: number | undefined, disposition: 'attachment' | 'inline', meta: RequestMeta): Promise<PreparedDownload> {
    const doc = await this.require(id);
    if (doc.deletedAt) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    let src = { key: doc.storageKey, mimeType: doc.mimeType, filename: doc.originalFilename, size: Number(doc.fileSize), version: doc.versionNumber };
    if (version !== undefined && version !== doc.versionNumber) {
      const v = await this.db.client.documentVersion.findFirst({ where: { documentId: id, versionNumber: version } });
      if (!v) throw notFound('DOCUMENT_VERSION_NOT_FOUND', 'Document version not found');
      src = { key: v.storageKey, mimeType: v.mimeType ?? doc.mimeType, filename: v.originalFilename, size: Number(v.fileSize ?? 0), version: v.versionNumber };
    }
    if (!(await this.storage.exists(src.key))) {
      throw new DomainError('DOCUMENT_FILE_MISSING', 'The stored file is missing; contact an administrator', 404);
    }
    await this.audit.record({
      tenantId: requireTenant().tenantId, actorUserId, action: 'DOCUMENT_DOWNLOADED', entityType: 'Document', entityId: id,
      after: { version: src.version, disposition }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return {
      key: src.key, mimeType: src.mimeType, filename: src.filename, size: src.size,
      // Only formats without active content may open in the browser; everything else downloads.
      disposition: disposition === 'inline' && INLINE_SAFE.has(src.mimeType) ? 'inline' : 'attachment',
    };
  }

  /** Issues a short-lived signed link (e.g. for <a href> / an embedded viewer that cannot send headers). */
  async createLink(auth: AuthContext, id: string, version: number | undefined, disposition: 'attachment' | 'inline') {
    const doc = await this.require(id); // tenant ownership verified by the scoped client
    if (doc.deletedAt) throw notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    if (version !== undefined && !(await this.db.client.documentVersion.findFirst({ where: { documentId: id, versionNumber: version } }))) {
      throw notFound('DOCUMENT_VERSION_NOT_FOUND', 'Document version not found');
    }
    const ttl = this.env.DOWNLOAD_LINK_TTL_SECONDS;
    const token = await this.tokens.signDownload(
      { sub: id, tid: auth.tenantId, uid: auth.userId, ver: version ?? doc.versionNumber, disp: disposition }, ttl,
    );
    return { url: `/api/v1/downloads/${token}`, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), expiresInSeconds: ttl };
  }

  /**
   * Redeems a signed link. The link is only a bearer for 60 s; we still re-verify that the
   * requester is an active member of the tenant and that the document belongs to it.
   */
  async redeemLink(token: string, meta: RequestMeta): Promise<PreparedDownload> {
    let p;
    try {
      p = await this.tokens.verifyDownload(token);
    } catch {
      throw unauthorized('INVALID_DOWNLOAD_LINK', 'This download link is invalid or has expired');
    }
    const membership = await this.prisma.client.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: p.tid, userId: p.uid } },
      include: { user: { select: { isActive: true } }, tenant: { select: { status: true } } },
    });
    if (!membership?.isActive || !membership.user.isActive || membership.tenant.status !== 'ACTIVE') {
      throw unauthorized('INVALID_DOWNLOAD_LINK', 'This download link is invalid or has expired');
    }
    return runWithTenant({ tenantId: p.tid, userId: p.uid }, () => this.prepareDownload(p.uid, p.sub, p.ver, p.disp, meta));
  }
}
