import { Controller, Get, Inject, Query } from '@nestjs/common';
import { z } from 'zod';
import { paginated } from '../../common/pagination';
import { ZodPipe } from '../../common/zod.pipe';
import { isoDateTime, uuid } from '../../common/zod-helpers';
import { TenantDbService } from '../../database/prisma.module';
import { RequirePermissions } from '../auth/decorators';

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().trim().min(1).max(80).optional(),
  entityType: z.string().trim().min(1).max(80).optional(),
  entityId: z.string().trim().min(1).max(80).optional(),
  actorUserId: uuid.optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
});

/**
 * Read-only audit trail for the office (spec 18.2). There is deliberately no way to create, change or
 * delete entries through the API — the database also refuses it (append-only trigger).
 */
@Controller('audit-logs')
export class AuditController {
  constructor(@Inject(TenantDbService) private readonly db: TenantDbService) {}

  @Get()
  @RequirePermissions('audit.view')
  async list(@Query(new ZodPipe(querySchema)) q: z.infer<typeof querySchema>) {
    const where = {
      ...(q.action && { action: q.action }),
      ...(q.entityType && { entityType: q.entityType }),
      ...(q.entityId && { entityId: q.entityId }),
      ...(q.actorUserId && { actorUserId: q.actorUserId }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) } }),
    };
    const [rows, total] = await Promise.all([
      this.db.client.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.db.client.auditLog.count({ where }),
    ]);
    const ids = [...new Set(rows.map((r) => r.actorUserId).filter((x): x is string => !!x))];
    const members = ids.length
      ? await this.db.client.tenantUser.findMany({ where: { userId: { in: ids } }, select: { userId: true, user: { select: { firstName: true, lastName: true, email: true } } } })
      : [];
    const actors = new Map(members.map((m) => [m.userId, { id: m.userId, name: `${m.user.firstName} ${m.user.lastName}`, email: m.user.email }]));
    return paginated(rows.map((r) => ({
      id: r.id, action: r.action, entityType: r.entityType, entityId: r.entityId,
      actor: r.actorUserId ? actors.get(r.actorUserId) ?? { id: r.actorUserId, name: null, email: null } : null,
      before: r.beforeData, after: r.afterData, ipAddress: r.ipAddress, userAgent: r.userAgent, createdAt: r.createdAt,
    })), q, total);
  }
}
