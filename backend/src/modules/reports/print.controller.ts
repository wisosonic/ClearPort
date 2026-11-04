import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { PrintService, type Printed } from './print.service';

const printQuery = z.object({
  locale: z.enum(['en', 'ar']).default('en'),
  /** html is a preview of exactly what the PDF contains */
  format: z.enum(['pdf', 'html']).default('pdf'),
  disposition: z.enum(['inline', 'attachment']).default('inline'),
});
const statementQuery = printQuery.extend({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
});
const id = () => new ZodPipe(uuid);

export function sendPrinted(res: Response, p: Printed, disposition: 'inline' | 'attachment' = 'inline') {
  res.setHeader('Content-Type', p.contentType);
  res.setHeader('Content-Length', String(p.body.length));
  res.setHeader('Content-Disposition', `${disposition}; filename="${p.filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  // an HTML preview may only show itself: no scripts, no outside resources, no framing by other sites
  if (p.contentType.startsWith('text/html')) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.end(p.body);
}

@Controller()
export class PrintController {
  constructor(@Inject(PrintService) private readonly print: PrintService) {}

  @RequirePermissions('invoices.view')
  @Get('invoices/:invoiceId/pdf')
  async invoice(
    @CurrentAuth() auth: AuthContext, @Param('invoiceId', id()) invoiceId: string, @Query(new ZodPipe(printQuery)) q: z.infer<typeof printQuery>,
    @ReqMeta() meta: RequestMeta, @Res() res: Response,
  ) {
    sendPrinted(res, await this.print.invoice(auth, invoiceId, q.locale, q.format, meta), q.disposition);
  }

  @RequirePermissions('clients.view', 'invoices.view', 'payments.view')
  @Get('clients/:clientId/statement/pdf')
  async statement(
    @CurrentAuth() auth: AuthContext, @Param('clientId', id()) clientId: string, @Query(new ZodPipe(statementQuery)) q: z.infer<typeof statementQuery>,
    @ReqMeta() meta: RequestMeta, @Res() res: Response,
  ) {
    sendPrinted(res, await this.print.statement(auth, clientId, q, q.locale, q.format, meta), q.disposition);
  }
}
