import { Body, Controller, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { conflict, forbidden, notFound, unprocessable } from '../../common/errors';
import { ZodPipe } from '../../common/zod.pipe';
import { PrismaService, TenantDbService } from '../../database/prisma.module';
import { AuditService } from '../audit/audit.service';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';

const permissionCodes = z.array(z.string().min(1).max(100)).max(200);
const createRoleSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/).min(2).max(50),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(300).optional(),
  permissionCodes,
});
const setPermissionsSchema = z.object({ permissionCodes });
const uuid = z.string().uuid();

/** A user may only grant permissions they hold themselves (no privilege escalation). */
export function assertCanGrant(auth: AuthContext, codes: Iterable<string>) {
  const notHeld = [...new Set(codes)].filter((c) => !auth.permissions.has(c));
  if (notHeld.length > 0) {
    throw forbidden('PRIVILEGE_ESCALATION', `You cannot grant permissions you do not hold: ${notHeld.join(', ')}`);
  }
}

@Controller()
export class RolesController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TenantDbService) private readonly db: TenantDbService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @RequirePermissions('roles.manage')
  @Get('permissions')
  async permissions() {
    return this.prisma.client.permission.findMany({ orderBy: { code: 'asc' } });
  }

  /** System roles plus this office's custom roles. */
  @RequirePermissions('users.manage')
  @Get('roles')
  async list() {
    const roles = await this.db.client.role.findMany({
      include: { permissions: { include: { permission: { select: { code: true } } } } },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
    return roles.map((r) => this.present(r));
  }

  @RequirePermissions('roles.manage')
  @Post('roles')
  async create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createRoleSchema)) body: z.infer<typeof createRoleSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    assertCanGrant(auth, body.permissionCodes);
    const permissions = await this.resolvePermissions(body.permissionCodes);
    // System role codes are reserved so a custom role can never shadow one.
    if (await this.prisma.client.role.findFirst({ where: { tenantId: null, code: body.code } })) {
      throw conflict('ROLE_CODE_RESERVED', `Role code ${body.code} is reserved for a system role`);
    }
    const role = await this.db.client.role.create({
      data: { code: body.code, name: body.name, description: body.description, isSystem: false } as any,
    });
    await this.prisma.client.rolePermission.createMany({
      data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'ROLE_CREATED', entityType: 'Role',
      entityId: role.id, after: { ...role, permissionCodes: body.permissionCodes }, ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(role.id);
  }

  @RequirePermissions('roles.manage')
  @Put('roles/:id/permissions')
  async setPermissions(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(setPermissionsSchema)) body: z.infer<typeof setPermissionsSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    const role = await this.db.client.role.findUnique({
      where: { id }, include: { permissions: { include: { permission: { select: { code: true } } } } },
    });
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Role not found');
    if (role.isSystem || role.tenantId === null) {
      throw forbidden('SYSTEM_ROLE_READONLY', 'System roles cannot be modified; create a custom role instead');
    }
    assertCanGrant(auth, body.permissionCodes);
    const permissions = await this.resolvePermissions(body.permissionCodes);
    const before = role.permissions.map((p) => p.permission.code).sort();

    await this.prisma.client.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId: id } });
      await tx.rolePermission.createMany({ data: permissions.map((p) => ({ roleId: id, permissionId: p.id })) });
    });
    await this.audit.record({
      tenantId: auth.tenantId, actorUserId: auth.userId, action: 'ROLE_PERMISSIONS_SET', entityType: 'Role',
      entityId: id, before: { permissionCodes: before }, after: { permissionCodes: [...body.permissionCodes].sort() },
      ip: meta.ip, userAgent: meta.userAgent,
    });
    return this.get(id);
  }

  // ── helpers ──

  private async get(id: string) {
    const role = await this.db.client.role.findUnique({
      where: { id }, include: { permissions: { include: { permission: { select: { code: true } } } } },
    });
    if (!role) throw notFound('ROLE_NOT_FOUND', 'Role not found');
    return this.present(role);
  }

  private present(r: { id: string; code: string; name: string; description: string | null; isSystem: boolean; permissions: { permission: { code: string } }[] }) {
    return {
      id: r.id, code: r.code, name: r.name, description: r.description, isSystem: r.isSystem,
      permissionCodes: r.permissions.map((p) => p.permission.code).sort(),
    };
  }

  private async resolvePermissions(codes: string[]) {
    const unique = [...new Set(codes)];
    const found = await this.prisma.client.permission.findMany({ where: { code: { in: unique } } });
    if (found.length !== unique.length) {
      const known = new Set(found.map((p) => p.code));
      throw unprocessable('UNKNOWN_PERMISSION', 'Unknown permission code(s)', unique.filter((c) => !known.has(c)));
    }
    return found;
  }
}
