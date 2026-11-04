import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { notFound } from '../../common/errors';
import { orderBy, pageArgs, paginated } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { requireTenant } from '../../database/tenant-context';
import { ZodPipe } from '../../common/zod.pipe';
import { TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import {
  createPartySchema, partyListQuerySchema, updatePartySchema,
} from './clients.schemas';

/**
 * Shipping agents, freight forwarders, suppliers, transporters... Deliberately separate from
 * clients (spec 11.2): a company can be both a client and a supplier; the two records are
 * independent and are not linked.
 */
@Controller('parties')
export class PartiesController {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @RequirePermissions('clients.view')
  @Get()
  async list(@Query(new ZodPipe(partyListQuerySchema)) q: z.infer<typeof partyListQuerySchema>) {
    const where: any = {};
    if (q.partyType) where.partyType = q.partyType;
    if (q.search) {
      where.id = {
        in: await searchIds(this.db.client, {
          table: 'business_parties', tenantId: requireTenant().tenantId, term: q.search,
          columns: ['name', 'taxNumber', 'phone', 'email'],
        }),
      };
    }
    const [rows, total] = await Promise.all([
      this.db.client.businessParty.findMany({
        where, ...pageArgs(q), orderBy: orderBy(q.sort, ['name', 'partyType', 'createdAt'] as const, { name: 'asc' }),
      }),
      this.db.client.businessParty.count({ where }),
    ]);
    return paginated(rows, q, total);
  }

  @RequirePermissions('clients.view')
  @Get(':id')
  async get(@Param('id', new ZodPipe(z.string().uuid())) id: string) {
    return this.find(id);
  }

  @RequirePermissions('clients.manage')
  @Post()
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createPartySchema)) body: z.infer<typeof createPartySchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const party = await this.db.client.businessParty.create({ data: body as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'PARTY_CREATED', entityType: 'BusinessParty',
      entityId: party.id, after: party, ip: meta.ip, userAgent: meta.userAgent,
    });
    return party;
  }

  @RequirePermissions('clients.manage')
  @Patch(':id')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodPipe(z.string().uuid())) id: string,
    @Body(new ZodPipe(updatePartySchema)) body: z.infer<typeof updatePartySchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const before = await this.find(id);
    const after = await this.db.client.businessParty.update({ where: { id }, data: body as any });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'PARTY_UPDATED', entityType: 'BusinessParty',
      entityId: id, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  private async find(id: string) {
    const party = await this.db.client.businessParty.findUnique({ where: { id } });
    if (!party) throw notFound('PARTY_NOT_FOUND', 'Business party not found');
    return party;
  }
}
