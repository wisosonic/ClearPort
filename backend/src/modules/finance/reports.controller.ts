import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, RequirePermissions } from '../auth/decorators';
import { reportQuerySchema } from './finance.schemas';
import { ReportsService } from './reports.service';

@Controller()
export class ReportsController {
  constructor(@Inject(ReportsService) private readonly reports: ReportsService) {}

  /** One file's financial picture: what it earned and cost the office, pass-through money, tax, FX, receivables. */
  @RequirePermissions('reports.view', 'clearance_files.view')
  @Get('clearance-files/:fileId/costs')
  fileCosts(@CurrentAuth() auth: AuthContext, @Param('fileId', new ZodPipe(uuid)) fileId: string) {
    return this.reports.fileCosts(auth.tenantId, fileId);
  }

  @RequirePermissions('reports.view')
  @Get('reports/profitability')
  profitability(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(reportQuerySchema)) q: z.infer<typeof reportQuerySchema>) {
    return this.reports.profitability(auth.tenantId, q);
  }

  @RequirePermissions('reports.view')
  @Get('reports/financial-summary')
  financialSummary(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(reportQuerySchema)) q: z.infer<typeof reportQuerySchema>) {
    return this.reports.financialSummary(auth.tenantId, q);
  }
}
