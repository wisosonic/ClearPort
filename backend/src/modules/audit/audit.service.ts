import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.module';

const SECRET_KEYS = new Set([
  'password', 'passwordHash', 'currentPassword', 'newPassword', 'token', 'tokenHash',
  'refreshToken', 'accessToken', 'storageKey',
]);

/** Deep-copies a value for the audit trail with every secret-looking field removed. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 6) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => sanitizeForAudit(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = typeof v === 'bigint' ? v.toString() : sanitizeForAudit(v, depth + 1);
  }
  return out;
}

export interface AuditEntry {
  tenantId?: string | null;
  actorUserId?: string | null;
  action: string; // e.g. AUTH_LOGIN, USER_CREATED
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string;
  userAgent?: string;
}

/**
 * Audit trail (accountability) — distinct from the human-readable file timeline (spec 11.5).
 * Never records passwords, tokens or document contents.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Audit failures must not break the business operation, but they must be visible. */
  async record(e: AuditEntry): Promise<void> {
    try {
      await this.prisma.client.auditLog.create({
        data: {
          tenantId: e.tenantId ?? null,
          actorUserId: e.actorUserId ?? null,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId ?? null,
          beforeData: e.before === undefined ? undefined : (sanitizeForAudit(e.before) as any),
          afterData: e.after === undefined ? undefined : (sanitizeForAudit(e.after) as any),
          ipAddress: e.ip ?? null,
          userAgent: e.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Failed to write audit log for ${e.action}: ${(err as Error).message}`);
    }
  }
}
