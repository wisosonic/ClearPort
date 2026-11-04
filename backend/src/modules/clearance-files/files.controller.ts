import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { searchIds } from '../../common/search';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import { TenantDbService } from '../../database/prisma.module';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import {
  assignSchema, createContainerSchema, createFileSchema, createGoodsSchema, createShipmentSchema,
  fileListQuerySchema, hsCodeQuerySchema, portQuerySchema, shipmentListQuerySchema, timelineQuerySchema, updateContainerSchema,
  updateFileSchema, updateGoodsSchema, updateShipmentSchema,
} from './files.schemas';
import { FilesService } from './files.service';
import { ShipmentsService } from './shipments.service';

const id = () => new ZodPipe(uuid);

@Controller('clearance-files')
export class FilesController {
  constructor(
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(ShipmentsService) private readonly shipments: ShipmentsService,
  ) {}

  @RequirePermissions('clearance_files.view')
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(fileListQuerySchema)) q: z.infer<typeof fileListQuerySchema>) {
    return this.files.list(auth, q);
  }

  /** The backend generates the file number and selects the workflow template. */
  @RequirePermissions('clearance_files.create')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createFileSchema)) body: z.infer<typeof createFileSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.files.create(auth, body, meta);
  }

  @RequirePermissions('clearance_files.view')
  @Get(':id')
  get(@Param('id', id()) fileId: string) {
    return this.files.get(fileId);
  }

  /** No status / stage here: stage changes use POST /clearance-files/:id/transition (Phase 4). */
  @RequirePermissions('clearance_files.update')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) fileId: string,
    @Body(new ZodPipe(updateFileSchema)) body: z.infer<typeof updateFileSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.files.update(auth, fileId, body, meta);
  }

  @RequirePermissions('clearance_files.assign')
  @HttpCode(200)
  @Post(':id/assign')
  assign(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) fileId: string,
    @Body(new ZodPipe(assignSchema)) body: z.infer<typeof assignSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.files.assign(auth, fileId, body.userId, meta);
  }

  @RequirePermissions('clearance_files.view')
  @Get(':id/timeline')
  timeline(@Param('id', id()) fileId: string, @Query(new ZodPipe(timelineQuerySchema)) q: z.infer<typeof timelineQuerySchema>) {
    return this.files.timeline(fileId, q);
  }

  @RequirePermissions('clearance_files.view')
  @Get(':id/summary')
  summary(@Param('id', id()) fileId: string) {
    return this.files.summary(fileId);
  }

  @RequirePermissions('clearance_files.view')
  @Get(':id/shipments')
  listShipments(@Param('id', id()) fileId: string) {
    return this.shipments.list(fileId);
  }

  @RequirePermissions('clearance_files.update')
  @Post(':id/shipments')
  createShipment(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) fileId: string,
    @Body(new ZodPipe(createShipmentSchema)) body: z.infer<typeof createShipmentSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.create(auth, fileId, body, meta);
  }
}

@Controller()
export class ShipmentsController {
  constructor(@Inject(ShipmentsService) private readonly shipments: ShipmentsService) {}

  /** Every shipment in the office (search matches BL numbers, vessel, voyage and container numbers). */
  @RequirePermissions('clearance_files.view')
  @Get('shipments')
  list(@Query(new ZodPipe(shipmentListQuerySchema)) q: z.infer<typeof shipmentListQuerySchema>) {
    return this.shipments.listAll(q);
  }

  @RequirePermissions('clearance_files.view')
  @Get('shipments/:id')
  get(@Param('id', id()) shipmentId: string) {
    return this.shipments.get(shipmentId);
  }

  @RequirePermissions('clearance_files.update')
  @Patch('shipments/:id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) shipmentId: string,
    @Body(new ZodPipe(updateShipmentSchema)) body: z.infer<typeof updateShipmentSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.update(auth, shipmentId, body, meta);
  }

  @RequirePermissions('clearance_files.update')
  @Post('shipments/:id/containers')
  addContainer(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) shipmentId: string,
    @Body(new ZodPipe(createContainerSchema)) body: z.infer<typeof createContainerSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.addContainer(auth, shipmentId, body, meta);
  }

  @RequirePermissions('clearance_files.update')
  @Patch('containers/:id')
  updateContainer(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) containerId: string,
    @Body(new ZodPipe(updateContainerSchema)) body: z.infer<typeof updateContainerSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.updateContainer(auth, containerId, body, meta);
  }

  @RequirePermissions('clearance_files.update')
  @Post('shipments/:id/goods')
  addGoods(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) shipmentId: string,
    @Body(new ZodPipe(createGoodsSchema)) body: z.infer<typeof createGoodsSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.addGoods(auth, shipmentId, body, meta);
  }

  @RequirePermissions('clearance_files.update')
  @Patch('goods/:id')
  updateGoods(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) goodsId: string,
    @Body(new ZodPipe(updateGoodsSchema)) body: z.infer<typeof updateGoodsSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.shipments.updateGoods(auth, goodsId, body, meta);
  }
}

/** Global reference lookups used by the shipment forms. */
@Controller()
export class ReferenceController {
  constructor(@Inject(TenantDbService) private readonly db: TenantDbService) {}

  @RequirePermissions('clearance_files.view')
  @Get('ports')
  async ports(@Query(new ZodPipe(portQuerySchema)) q: z.infer<typeof portQuerySchema>) {
    const where: any = {};
    if (q.countryCode) where.countryCode = q.countryCode;
    if (q.portType) where.portType = q.portType;
    if (q.search) where.id = { in: await searchIds(this.db.client, { table: 'ports', columns: ['code', 'name'], term: q.search }) };
    const [rows, total] = await Promise.all([
      this.db.client.port.findMany({ where, ...pageArgs(q), orderBy: orderBy(q.sort, ['name', 'code'] as const, { name: 'asc' }) }),
      this.db.client.port.count({ where }),
    ]);
    return paginated(rows, q, total);
  }

  /**
   * HS codes are reference data with source, jurisdiction and effective dates (spec 11.7). None are
   * seeded: an international heading is not the complete Lebanese tariff classification, so the
   * list must come from a verified source.
   */
  @RequirePermissions('clearance_files.view')
  @Get('hs-codes')
  async hsCodes(@Query(new ZodPipe(hsCodeQuerySchema)) q: z.infer<typeof hsCodeQuerySchema>) {
    const where: any = { isActive: true };
    if (q.jurisdiction) where.jurisdiction = q.jurisdiction;
    if (q.search) where.id = { in: await searchIds(this.db.client, { table: 'hs_codes', columns: ['code', 'description'], term: q.search }) };
    const [rows, total] = await Promise.all([
      this.db.client.hsCode.findMany({ where, ...pageArgs(q), orderBy: orderBy(q.sort, ['code'] as const, { code: 'asc' }) }),
      this.db.client.hsCode.count({ where }),
    ]);
    return paginated(rows, q, total);
  }
}
