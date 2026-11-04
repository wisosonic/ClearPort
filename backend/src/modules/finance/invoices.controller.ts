import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { FilesService } from '../clearance-files/files.service';
import {
  createInvoiceSchema, invoiceListQuerySchema, issueInvoiceSchema, reasonSchema, updateInvoiceSchema,
} from './finance.schemas';
import { InvoicesService } from './invoices.service';

const id = () => new ZodPipe(uuid);

@Controller()
export class InvoicesController {
  constructor(
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  @RequirePermissions('invoices.view')
  @Get('invoices')
  list(@Query(new ZodPipe(invoiceListQuerySchema)) q: z.infer<typeof invoiceListQuerySchema>) {
    return this.invoices.list(q);
  }

  /** Creates a DRAFT: no number yet, no accounting. */
  @RequirePermissions('invoices.create')
  @Post('invoices')
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createInvoiceSchema)) body: z.infer<typeof createInvoiceSchema>, @ReqMeta() meta: RequestMeta) {
    return this.invoices.create(auth, body, meta);
  }

  @RequirePermissions('invoices.view')
  @Get('invoices/:invoiceId')
  get(@Param('invoiceId', id()) invoiceId: string) {
    return this.invoices.get(invoiceId);
  }

  @RequirePermissions('invoices.create')
  @Patch('invoices/:invoiceId')
  update(
    @CurrentAuth() auth: AuthContext, @Param('invoiceId', id()) invoiceId: string,
    @Body(new ZodPipe(updateInvoiceSchema)) body: z.infer<typeof updateInvoiceSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.invoices.update(auth, invoiceId, body, meta);
  }

  /** Assigns the next invoice number, freezes the invoice and posts it to the ledger. */
  @RequirePermissions('invoices.issue')
  @HttpCode(200)
  @Post('invoices/:invoiceId/issue')
  issue(
    @CurrentAuth() auth: AuthContext, @Param('invoiceId', id()) invoiceId: string,
    @Body(new ZodPipe(issueInvoiceSchema)) body: z.infer<typeof issueInvoiceSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.invoices.issue(auth, invoiceId, body, meta);
  }

  @RequirePermissions('invoices.issue')
  @HttpCode(200)
  @Post('invoices/:invoiceId/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext, @Param('invoiceId', id()) invoiceId: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.invoices.cancel(auth, invoiceId, body.reason, meta);
  }

  @RequirePermissions('invoices.view')
  @Get('clearance-files/:fileId/invoices')
  async fileInvoices(@Param('fileId', id()) fileId: string, @Query(new ZodPipe(invoiceListQuerySchema)) q: z.infer<typeof invoiceListQuerySchema>) {
    await this.files.require(fileId);
    return this.invoices.list(q, fileId);
  }
}
