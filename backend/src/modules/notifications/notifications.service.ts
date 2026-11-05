import { Inject, Injectable } from '@nestjs/common';
import { notFound } from '../../common/errors';
import { paginated } from '../../common/pagination';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { requireTenant } from '../../database/tenant-context';
import type { AuthContext } from '../auth/auth.types';

export interface NewNotification { userId: string; type: string; title: string; body?: string | null; metadata?: Record<string, unknown> }

/**
 * In-app notifications. Everything that tells someone about something goes through `create`, which honours the
 * office's "in-app notifications" switch. (Email and SMS are recorded as office choices only: no delivery service is connected.)
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /** `client` is the caller's transaction (or the tenant client). Returns false when the office has switched in-app notifications off. */
  async create(client: { notification: { create: (a: any) => Promise<unknown> } }, data: NewNotification): Promise<boolean> {
    const office = await this.prisma.client.tenant.findUnique({ where: { id: requireTenant().tenantId }, select: { notifyInApp: true } });
    if (!office?.notifyInApp) return false;
    await client.notification.create({ data: { userId: data.userId, type: data.type, title: data.title, body: data.body ?? null, metadata: data.metadata ?? undefined } });
    return true;
  }

  async list(auth: AuthContext, q: { page: number; limit: number; unread?: boolean }) {
    const where = { userId: auth.userId, ...(q.unread && { readAt: null }) };
    const [rows, total, unread] = await Promise.all([
      this.db.client.notification.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.db.client.notification.count({ where }),
      this.db.client.notification.count({ where: { userId: auth.userId, readAt: null } }),
    ]);
    const res = paginated(rows, q, total);
    Object.assign(res.meta, { unreadCount: unread });
    return res;
  }

  async markRead(auth: AuthContext, id: string) {
    const n = await this.db.client.notification.findFirst({ where: { id, userId: auth.userId } });
    if (!n) throw notFound('NOTIFICATION_NOT_FOUND', 'Notification not found');
    if (!n.readAt) await this.db.client.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(auth: AuthContext) {
    const res = await this.db.client.notification.updateMany({ where: { userId: auth.userId, readAt: null }, data: { readAt: new Date() } });
    return { marked: res.count };
  }
}
