import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { listQuerySchema, orderBy, pageArgs, paginated } from '../../common/pagination';
import { searchIds } from '../../common/search';
import { requireTenant } from '../../database/tenant-context';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import { AuthService, hashPassword, passwordSchema } from '../auth/auth.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { assertCanGrant } from '../roles/roles.controller';

const uuid = z.string().uuid();
export const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(150),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(50).optional(),
  /** Required only when the e-mail is not already a ClearPort user. */
  password: passwordSchema.optional(),
  branchId: uuid.optional(),
  roleIds: z.array(uuid).min(1).max(20),
});
export const updateUserSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(50).nullable(),
  branchId: uuid.nullable(),
  roleIds: z.array(uuid).min(1).max(20),
}).partial().strict();
export const userStatusSchema = z.object({ isActive: z.boolean() }).strict();
export const userListQuerySchema = listQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  roleCode: z.string().max(50).optional(),
});

type Membership = Awaited<ReturnType<UsersService['loadMembership']>>;

@Injectable()
export class UsersService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AuthService) private readonly auth: AuthService,
  ) {}

  async list(q: z.infer<typeof userListQuerySchema>) {
    const where: any = {};
    if (q.search) {
      // users is a global table: scope the match to this office's members
      const ids = await searchIds(this.db.client, {
        table: 'users', columns: ['email', 'firstName', 'lastName'], term: q.search,
        extraWhere: '"id" IN (SELECT "userId" FROM "tenant_users" WHERE "tenantId" = ?)',
        extraParams: [requireTenant().tenantId],
      });
      where.userId = { in: ids };
    }
    if (q.isActive !== undefined) where.isActive = q.isActive === 'true';
    if (q.roleCode) where.userRoles = { some: { role: { code: q.roleCode } } };
    const sort = orderBy(q.sort, ['joinedAt'] as const, { joinedAt: 'desc' });

    const [rows, total] = await Promise.all([
      this.db.client.tenantUser.findMany({ where, ...pageArgs(q), orderBy: sort, include: this.include }),
      this.db.client.tenantUser.count({ where }),
    ]);
    return paginated(rows.map((m) => this.present(m)), q, total);
  }

  async get(userId: string) {
    return this.present(await this.loadMembership(userId));
  }

  async create(auth: AuthContext, input: z.infer<typeof createUserSchema>, meta: RequestMeta) {
    const roles = await this.resolveRoles(auth, input.roleIds);
    if (input.branchId) await this.assertBranch(input.branchId);

    const root = this.prisma.client;
    const existing = await root.user.findUnique({ where: { email: input.email } });
    if (!existing && !input.password) throw unprocessable('PASSWORD_REQUIRED', 'password is required for a new user');
    if (existing && (await this.db.client.tenantUser.findFirst({ where: { userId: existing.id } }))) {
      throw conflict('USER_ALREADY_MEMBER', 'This user already belongs to your office');
    }
    const passwordHash = existing ? undefined : await hashPassword(input.password!);

    const user = await root.$transaction(async (tx) => {
      const u = existing ?? (await tx.user.create({
        data: {
          email: input.email, passwordHash: passwordHash!, firstName: input.firstName,
          lastName: input.lastName, phone: input.phone,
        },
      }));
      await tx.tenantUser.create({
        data: { tenantId: auth.tenantId, userId: u.id, branchId: input.branchId ?? null },
      });
      await tx.userRole.createMany({
        data: roles.map((r) => ({ tenantId: auth.tenantId, userId: u.id, roleId: r.id })),
      });
      return u;
    });
    const created = await this.get(user.id);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'USER_CREATED', entityType: 'User',
      entityId: user.id, after: { ...created, existingAccountLinked: !!existing }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return created;
  }

  async update(auth: AuthContext, userId: string, input: z.infer<typeof updateUserSchema>, meta: RequestMeta) {
    const current = await this.loadMembership(userId);
    const before = this.present(current);
    const root = this.prisma.client;

    const profileChange = input.firstName !== undefined || input.lastName !== undefined || input.phone !== undefined;
    if (profileChange) {
      // A user account is shared across offices; one office must not rewrite it for the others.
      const memberships = await root.tenantUser.count({ where: { userId } });
      if (memberships > 1) {
        throw conflict('PROFILE_SHARED', 'This user belongs to several offices; they must edit their own profile');
      }
    }
    let roles: { id: string }[] | undefined;
    if (input.roleIds) {
      roles = await this.resolveRoles(auth, input.roleIds);
      await this.assertKeepsAnOwner(current, roles.map((r) => r.id));
    }
    if (input.branchId) await this.assertBranch(input.branchId);

    await root.$transaction(async (tx) => {
      if (profileChange) {
        await tx.user.update({
          where: { id: userId },
          data: { firstName: input.firstName, lastName: input.lastName, phone: input.phone },
        });
      }
      if (input.branchId !== undefined) {
        await tx.tenantUser.update({ where: { id: current.id }, data: { branchId: input.branchId } });
      }
      if (roles) {
        await tx.userRole.deleteMany({ where: { tenantId: auth.tenantId, userId } });
        await tx.userRole.createMany({ data: roles.map((r) => ({ tenantId: auth.tenantId, userId, roleId: r.id })) });
      }
    });
    const after = await this.get(userId);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'USER_UPDATED', entityType: 'User',
      entityId: userId, before, after, ip: meta.ip, userAgent: meta.userAgent,
    });
    return after;
  }

  async setStatus(auth: AuthContext, userId: string, isActive: boolean, meta: RequestMeta) {
    const current = await this.loadMembership(userId);
    if (userId === auth.userId && !isActive) {
      throw forbidden('CANNOT_DEACTIVATE_SELF', 'You cannot deactivate your own account');
    }
    if (!isActive) await this.assertKeepsAnOwner(current, []);

    await this.db.client.tenantUser.update({ where: { id: current.id }, data: { isActive } });
    // Spec 9.4: refresh tokens are revoked on account deactivation. Access tokens die immediately
    // too, because the auth guard re-checks the membership on every request.
    if (!isActive) await this.auth.revokeUserSessionsInTenant(userId, auth.tenantId);
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId,
      action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', entityType: 'User', entityId: userId,
      before: { isActive: current.isActive }, after: { isActive }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(userId);
  }

  // ── helpers ──

  private readonly include = {
    user: { select: { id: true, email: true, firstName: true, lastName: true, phone: true, isActive: true, lastLoginAt: true } },
    branch: { select: { id: true, code: true, name: true } },
    userRoles: { include: { role: { select: { id: true, code: true, name: true } } } },
  } as const;

  /** `userId` is the public id; the tenant client guarantees only this office's members are found. */
  private async loadMembership(userId: string) {
    const m = await this.db.client.tenantUser.findFirst({ where: { userId }, include: this.include });
    if (!m) throw notFound('USER_NOT_FOUND', 'User not found');
    return m;
  }

  private present(m: Membership) {
    return {
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      phone: m.user.phone,
      isActive: m.isActive && m.user.isActive,
      lastLoginAt: m.user.lastLoginAt,
      joinedAt: m.joinedAt,
      branch: m.branch,
      roles: m.userRoles.map((ur) => ur.role),
    };
  }

  /** Roles must be system roles or this office's own, and the caller must hold their permissions. */
  private async resolveRoles(auth: AuthContext, roleIds: string[]) {
    const unique = [...new Set(roleIds)];
    const roles = await this.db.client.role.findMany({
      where: { id: { in: unique } },
      include: { permissions: { include: { permission: { select: { code: true } } } } },
    });
    if (roles.length !== unique.length) throw unprocessable('ROLE_NOT_FOUND', 'One or more roles do not exist');
    for (const r of roles) assertCanGrant(auth, r.permissions.map((p) => p.permission.code));
    return roles;
  }

  private async assertBranch(branchId: string) {
    if (!(await this.db.client.branch.findUnique({ where: { id: branchId } }))) {
      throw unprocessable('BRANCH_NOT_FOUND', 'Branch not found in your office');
    }
  }

  /** The office must always keep at least one active Owner. */
  private async assertKeepsAnOwner(current: Membership, newRoleIds: string[]) {
    const isOwner = current.userRoles.some((ur) => ur.role.code === 'OWNER');
    if (!isOwner || !current.isActive) return;
    const ownerRole = await this.prisma.client.role.findFirstOrThrow({ where: { tenantId: null, code: 'OWNER' } });
    if (newRoleIds.includes(ownerRole.id)) return;
    const otherOwners = await this.db.client.tenantUser.count({
      where: { isActive: true, userId: { not: current.userId }, userRoles: { some: { roleId: ownerRole.id } }, user: { isActive: true } },
    });
    if (otherOwners === 0) throw conflict('LAST_OWNER', 'The office must keep at least one active Owner');
  }
}
