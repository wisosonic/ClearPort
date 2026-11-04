import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { z } from 'zod';
import { badRequest, forbidden, unauthorized } from '../../common/errors';
import { PrismaService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from './auth.types';
import { TokenService } from './token.service';

// ── input schemas ──
const email = z.string().trim().toLowerCase().email().max(150);
export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128, 'Password must be at most 128 characters');

export const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  tenantSlug: z.string().trim().toLowerCase().max(100).optional(),
});
export const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});
export const switchTenantSchema = z.object({ tenantSlug: z.string().trim().toLowerCase().min(1).max(100) });

export type LoginInput = z.infer<typeof loginSchema>;

const ARGON_OPTIONS = { type: argon2.argon2id } as const;
// Verified against when the e-mail is unknown, so response time does not reveal which e-mails exist.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= argon2.hash('clearport-dummy-password', ARGON_OPTIONS));

export const hashPassword = (plain: string) => argon2.hash(plain, ARGON_OPTIONS);

@Injectable()
export class AuthService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput, meta: RequestMeta) {
    const db = this.prisma.client;
    const user = await db.user.findUnique({ where: { email: input.email } });

    const passwordOk = user
      ? await argon2.verify(user.passwordHash, input.password).catch(() => false)
      : (await argon2.verify(await getDummyHash(), input.password).catch(() => false), false);

    if (!user || !passwordOk || !user.isActive) {
      await this.audit.record({
        action: 'AUTH_LOGIN_FAILED', entityType: 'User', entityId: user?.id ?? null,
        after: { email: input.email }, ip: meta.ip, userAgent: meta.userAgent,
      });
      throw unauthorized('INVALID_CREDENTIALS', 'Invalid e-mail or password');
    }

    const memberships = await db.tenantUser.findMany({
      where: { userId: user.id, isActive: true, tenant: { status: 'ACTIVE' } },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
      orderBy: { joinedAt: 'asc' },
    });
    if (memberships.length === 0) throw forbidden('NO_ACTIVE_TENANT', 'Your account has no active office');

    let chosen = memberships[0];
    if (input.tenantSlug) {
      const m = memberships.find((x) => x.tenant.slug === input.tenantSlug);
      if (!m) throw forbidden('TENANT_ACCESS_DENIED', 'You do not have access to that office');
      chosen = m;
    } else if (memberships.length > 1) {
      return {
        tenantSelectionRequired: true as const,
        tenants: memberships.map((m) => ({ id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name })),
      };
    }

    const session = await this.startSession(user.id, chosen.tenantId, meta);
    await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      tenantId: chosen.tenantId, actorUserId: user.id, action: 'AUTH_LOGIN', entityType: 'User',
      entityId: user.id, ip: meta.ip, userAgent: meta.userAgent,
    });
    return session;
  }

  /** Rotating refresh tokens with reuse detection: replaying a used token kills the whole session. */
  async refresh(refreshToken: string, meta: RequestMeta) {
    const db = this.prisma.client;
    const hash = TokenService.hash(refreshToken);
    const row = await db.refreshSession.findUnique({ where: { tokenHash: hash } });
    if (!row) throw unauthorized('INVALID_REFRESH_TOKEN', 'Invalid refresh token');

    if (row.revokedAt) {
      // Only a token that was already ROTATED (it has a replacement) counts as reuse: someone is
      // replaying an old token, so assume theft and revoke the whole family. A token revoked by
      // logout, password change or deactivation has no replacement and is simply rejected —
      // otherwise every client retry after logout would raise a false theft alert.
      if (row.replacedById) {
        await db.refreshSession.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit.record({
          tenantId: row.tenantId, actorUserId: row.userId, action: 'AUTH_REFRESH_REUSE_DETECTED',
          entityType: 'RefreshSession', entityId: row.id, ip: meta.ip, userAgent: meta.userAgent,
        });
      }
      throw unauthorized('INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    }
    if (row.expiresAt <= new Date() || !row.tenantId) throw unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token expired');

    const membership = await db.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: row.tenantId, userId: row.userId } },
      include: { user: { select: { isActive: true } }, tenant: { select: { status: true } } },
    });
    if (!membership?.isActive || !membership.user.isActive || membership.tenant.status !== 'ACTIVE') {
      await db.refreshSession.updateMany({ where: { familyId: row.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw unauthorized('ACCESS_REVOKED', 'Access to this office is no longer available');
    }

    const next = this.tokens.newRefreshToken();
    const nextId = randomUUID();
    const rotated = await db.$transaction(async (tx) => {
      // Atomic claim: only one concurrent request can consume this token.
      const claimed = await tx.refreshSession.updateMany({
        where: { id: row.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: nextId },
      });
      if (claimed.count !== 1) return false;
      await tx.refreshSession.create({
        data: {
          id: nextId, userId: row.userId, tenantId: row.tenantId, tokenHash: next.hash, familyId: row.familyId,
          expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs), userAgent: meta.userAgent, ipAddress: meta.ip,
        },
      });
      return true;
    });
    if (!rotated) throw unauthorized('INVALID_REFRESH_TOKEN', 'Invalid refresh token');

    return this.tokenResponse(row.userId, row.tenantId, row.familyId, next.token);
  }

  async logout(auth: AuthContext, meta: RequestMeta) {
    await this.prisma.client.refreshSession.updateMany({
      where: { familyId: auth.sessionId, revokedAt: null }, data: { revokedAt: new Date() },
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'AUTH_LOGOUT', entityType: 'User',
      entityId: auth.userId, ip: meta.ip, userAgent: meta.userAgent,
    });
  }

  async me(auth: AuthContext) {
    const m = await this.prisma.client.tenantUser.findUniqueOrThrow({
      where: { id: auth.membershipId },
      include: {
        user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, lastLoginAt: true } },
        tenant: { select: { id: true, slug: true, name: true, defaultCurrency: true, timezone: true, locale: true } },
        branch: { select: { id: true, code: true, name: true } },
        userRoles: { include: { role: { select: { id: true, code: true, name: true } } } },
      },
    });
    const others = await this.prisma.client.tenantUser.findMany({
      where: { userId: auth.userId, isActive: true, tenant: { status: 'ACTIVE' } },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
    });
    return {
      user: m.user,
      tenant: m.tenant,
      branch: m.branch,
      roles: m.userRoles.map((ur) => ur.role),
      permissions: [...auth.permissions].sort(),
      availableTenants: others.map((o) => o.tenant),
    };
  }

  async changePassword(auth: AuthContext, input: z.infer<typeof changePasswordSchema>, meta: RequestMeta) {
    const db = this.prisma.client;
    const user = await db.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!(await argon2.verify(user.passwordHash, input.currentPassword).catch(() => false))) {
      throw unauthorized('INVALID_CREDENTIALS', 'Current password is incorrect');
    }
    if (input.currentPassword === input.newPassword) {
      throw badRequest('PASSWORD_UNCHANGED', 'New password must differ from the current password');
    }
    await db.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(input.newPassword) } });
    // All sessions on every office end; the user signs in again with the new password.
    await db.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'AUTH_PASSWORD_CHANGED', entityType: 'User',
      entityId: user.id, ip: meta.ip, userAgent: meta.userAgent,
    });
  }

  /** Moves the signed-in user to another office they are an active member of. */
  async switchTenant(auth: AuthContext, tenantSlug: string, meta: RequestMeta) {
    const m = await this.prisma.client.tenantUser.findFirst({
      where: { userId: auth.userId, isActive: true, tenant: { slug: tenantSlug, status: 'ACTIVE' } },
    });
    if (!m) throw forbidden('TENANT_ACCESS_DENIED', 'You do not have access to that office');
    const session = await this.startSession(auth.userId, m.tenantId, meta);
    await this.audit.record({
      tenantId: m.tenantId, actorUserId: auth.userId, action: 'AUTH_TENANT_SWITCHED', entityType: 'Tenant',
      entityId: m.tenantId, ip: meta.ip, userAgent: meta.userAgent,
    });
    return session;
  }

  // ── helpers ──

  private async startSession(userId: string, tenantId: string, meta: RequestMeta) {
    const familyId = randomUUID();
    const refresh = this.tokens.newRefreshToken();
    await this.prisma.client.refreshSession.create({
      data: {
        userId, tenantId, familyId, tokenHash: refresh.hash,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlMs),
        userAgent: meta.userAgent, ipAddress: meta.ip,
      },
    });
    return this.tokenResponse(userId, tenantId, familyId, refresh.token);
  }

  private async tokenResponse(userId: string, tenantId: string, familyId: string, refreshToken: string) {
    const accessToken = await this.tokens.signAccess({ sub: userId, tid: tenantId, sid: familyId });
    const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
      where: { id: tenantId }, select: { id: true, slug: true, name: true },
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer' as const,
      expiresIn: this.tokens.accessTtlSeconds,
      tenant,
    };
  }

  /** Revokes every session of a user in one tenant (used when a membership is deactivated). */
  async revokeUserSessionsInTenant(userId: string, tenantId: string) {
    await this.prisma.client.refreshSession.updateMany({
      where: { userId, tenantId, revokedAt: null }, data: { revokedAt: new Date() },
    });
  }
}
