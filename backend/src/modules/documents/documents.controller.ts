import {
  Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { conflict, forbidden, notFound } from '../../common/errors';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { LocalStorageService } from '../../infrastructure/storage/local-storage.service';
import { UploadInterceptor } from '../../infrastructure/storage/upload.interceptor';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, Public, ReqMeta, RequirePermissions } from '../auth/decorators';
import { FilesService } from '../clearance-files/files.service';
import {
  createDocumentTypeSchema, createRequirementSchema, documentListQuerySchema, documentStatusSchema,
  downloadQuerySchema, requirementListQuerySchema, updateDocumentTypeSchema, updateRequirementSchema,
  uploadFieldsSchema, versionFieldsSchema,
} from './documents.schemas';
import { DocumentsService, type PreparedDownload } from './documents.service';
import { RequirementsService } from './requirements.service';

const id = () => new ZodPipe(uuid);

/** RFC 6266 / 5987 header value: ASCII fallback plus the real UTF-8 name (Arabic file names). */
function contentDisposition(kind: 'attachment' | 'inline', filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

@Controller()
export class DocumentsController {
  constructor(
    @Inject(DocumentsService) private readonly docs: DocumentsService,
    @Inject(RequirementsService) private readonly requirements: RequirementsService,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(LocalStorageService) private readonly storage: LocalStorageService,
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // ───────────────────────────── per-file ─────────────────────────────

  @RequirePermissions('documents.view')
  @Get('clearance-files/:fileId/documents')
  async fileDocuments(@Param('fileId', id()) fileId: string, @Query(new ZodPipe(documentListQuerySchema)) q: z.infer<typeof documentListQuerySchema>) {
    await this.files.require(fileId);
    return this.docs.list(q, fileId);
  }

  @RequirePermissions('clearance_files.view')
  @Get('clearance-files/:fileId/document-requirements')
  checklist(@Param('fileId', id()) fileId: string) {
    return this.requirements.checklist(fileId);
  }

  /** multipart/form-data: field "file" plus text fields documentTypeId, notes. */
  @RequirePermissions('documents.upload')
  @UseInterceptors(UploadInterceptor)
  @Post('clearance-files/:fileId/documents')
  upload(
    @CurrentAuth() auth: AuthContext,
    @Param('fileId', id()) fileId: string,
    @Body(new ZodPipe(uploadFieldsSchema)) fields: z.infer<typeof uploadFieldsSchema>,
    @UploadedFile() file: Express.Multer.File | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.docs.upload(auth, fileId, fields, file, meta);
  }

  // ───────────────────────────── single document ─────────────────────────────

  @RequirePermissions('documents.view')
  @Get('documents')
  list(@Query(new ZodPipe(documentListQuerySchema)) q: z.infer<typeof documentListQuerySchema>) {
    return this.docs.list(q);
  }

  @RequirePermissions('documents.view')
  @Get('documents/:docId')
  get(@Param('docId', id()) docId: string) {
    return this.docs.get(docId);
  }

  /** Streams the file after verifying tenant ownership. Never exposes a storage path. */
  @RequirePermissions('documents.view')
  @Get('documents/:docId/download')
  async download(
    @CurrentAuth() auth: AuthContext,
    @Param('docId', id()) docId: string,
    @Query(new ZodPipe(downloadQuerySchema)) q: z.infer<typeof downloadQuerySchema>,
    @ReqMeta() meta: RequestMeta,
    @Res() res: Response,
  ) {
    this.send(res, await this.docs.prepareDownload(auth.userId, docId, q.version, q.disposition, meta));
  }

  /** Short-lived signed link for places that cannot send an Authorization header. */
  @RequirePermissions('documents.view')
  @Get('documents/:docId/link')
  link(
    @CurrentAuth() auth: AuthContext,
    @Param('docId', id()) docId: string,
    @Query(new ZodPipe(downloadQuerySchema)) q: z.infer<typeof downloadQuerySchema>,
  ) {
    return this.docs.createLink(auth, docId, q.version, q.disposition);
  }

  @Public()
  @Get('downloads/:token')
  async redeem(@Param('token') token: string, @ReqMeta() meta: RequestMeta, @Res() res: Response) {
    this.send(res, await this.docs.redeemLink(token, meta));
  }

  @RequirePermissions('documents.upload')
  @UseInterceptors(UploadInterceptor)
  @Post('documents/:docId/versions')
  addVersion(
    @CurrentAuth() auth: AuthContext,
    @Param('docId', id()) docId: string,
    @Body(new ZodPipe(versionFieldsSchema)) fields: z.infer<typeof versionFieldsSchema>,
    @UploadedFile() file: Express.Multer.File | undefined,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.docs.addVersion(auth, docId, fields.notes, file, meta);
  }

  @RequirePermissions('documents.review')
  @Patch('documents/:docId/status')
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('docId', id()) docId: string,
    @Body(new ZodPipe(documentStatusSchema)) body: z.infer<typeof documentStatusSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.docs.setStatus(auth, docId, body, meta);
  }

  /** Voids (soft-deletes) the document; the stored bytes and history are kept. */
  @RequirePermissions('documents.delete')
  @HttpCode(204)
  @Delete('documents/:docId')
  async void(@CurrentAuth() auth: AuthContext, @Param('docId', id()) docId: string, @ReqMeta() meta: RequestMeta) {
    await this.docs.void(auth, docId, meta);
  }

  private send(res: Response, d: PreparedDownload) {
    res.setHeader('Content-Type', d.mimeType);
    if (d.size) res.setHeader('Content-Length', String(d.size));
    res.setHeader('Content-Disposition', contentDisposition(d.disposition, d.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (d.disposition === 'inline') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    const stream = this.storage.open(d.key);
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  // ───────────────────────────── document types ─────────────────────────────

  @RequirePermissions('documents.view')
  @Get('document-types')
  async types() {
    return this.db.client.documentType.findMany({ orderBy: [{ tenantId: 'asc' }, { nameEn: 'asc' }] });
  }

  @RequirePermissions('settings.manage')
  @Post('document-types')
  async createType(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createDocumentTypeSchema)) body: z.infer<typeof createDocumentTypeSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    // Codes of system types are reserved so a custom type can never shadow one.
    if (await this.prisma.client.documentType.findFirst({ where: { tenantId: null, code: body.code } })) {
      throw conflict('DOCUMENT_TYPE_CODE_RESERVED', `Code ${body.code} is used by a system document type`);
    }
    if (await this.db.client.documentType.findFirst({ where: { code: body.code } })) {
      throw conflict('DOCUMENT_TYPE_CODE_TAKEN', `Document type ${body.code} already exists`);
    }
    const row = await this.db.client.documentType.create({ data: body as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_TYPE_CREATED', entityType: 'DocumentType',
      entityId: row.id, after: row, ip: meta.ip, userAgent: meta.userAgent,
    });
    return row;
  }

  @RequirePermissions('settings.manage')
  @Patch('document-types/:typeId')
  async updateType(
    @CurrentAuth() auth: AuthContext,
    @Param('typeId', id()) typeId: string,
    @Body(new ZodPipe(updateDocumentTypeSchema)) body: z.infer<typeof updateDocumentTypeSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const before = await this.db.client.documentType.findUnique({ where: { id: typeId } });
    if (!before) throw notFound('DOCUMENT_TYPE_NOT_FOUND', 'Document type not found');
    if (before.tenantId === null) throw forbidden('SYSTEM_DOCUMENT_TYPE_READONLY', 'System document types cannot be modified');
    const after = await this.db.client.documentType.update({ where: { id: typeId }, data: body as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'DOCUMENT_TYPE_UPDATED', entityType: 'DocumentType',
      entityId: typeId, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  // ───────────────────────────── requirement configuration ─────────────────────────────

  @RequirePermissions('documents.view')
  @Get('document-requirements')
  listRequirements(@Query(new ZodPipe(requirementListQuerySchema)) q: z.infer<typeof requirementListQuerySchema>) {
    return this.requirements.list(q.fileType);
  }

  @RequirePermissions('workflows.manage')
  @Post('document-requirements')
  createRequirement(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createRequirementSchema)) body: z.infer<typeof createRequirementSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.requirements.create(auth, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @Patch('document-requirements/:reqId')
  updateRequirement(
    @CurrentAuth() auth: AuthContext,
    @Param('reqId', id()) reqId: string,
    @Body(new ZodPipe(updateRequirementSchema)) body: z.infer<typeof updateRequirementSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.requirements.update(auth, reqId, body, meta);
  }

  @RequirePermissions('workflows.manage')
  @HttpCode(204)
  @Delete('document-requirements/:reqId')
  async removeRequirement(@CurrentAuth() auth: AuthContext, @Param('reqId', id()) reqId: string, @ReqMeta() meta: RequestMeta) {
    await this.requirements.remove(auth, reqId, meta);
  }
}
