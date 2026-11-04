import {
  type CanActivate, type CallHandler, type ExecutionContext, Inject, Injectable, Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { forbidden, unauthorized } from '../../common/errors';
import { PrismaService } from '../../database/prisma.module';
import { runWithTenant } from '../../database/tenant-context';
import type { AuthContext } from './auth.types';
import { AUTHENTICATED_KEY, IS_PUBLIC, PERMISSIONS_KEY } from './decorators';
import { TokenService } from './token.service';

/**
 * Authenticates the request and establishes the tenant context.
 *
 * The tenant id inside the token is NOT trusted by itself: on every request we re-verify that
 * the user is active, is an ACTIVE member of that tenant, the tenant is active and the session
 * has not been revoked. Permissions are resolved from the user's roles in that tenant, so role
 * or deactivation changes take effect immediately (not after token expiry).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized('UNAUTHENTICATED', 'Authentication required');

    let payload;
    try {
      payload = await this.tokens.verifyAccess(header.slice(7));
    } catch {
      throw unauthorized('INVALID_TOKEN', 'Invalid or expired access token');
    }

    const now = new Date();
    const membership = await this.prisma.client.tenantUser.findUnique({
      where: { tenantId_userId: { tenantId: payload.tid, userId: payload.sub } },
      include: {
        user: { select: { id: true, email: true, isActive: true } },
        tenant: { select: { status: true } },
        userRoles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      },
    });
    if (!membership || !membership.isActive || !membership.user.isActive || membership.tenant.status !== 'ACTIVE') {
      throw unauthorized('ACCESS_REVOKED', 'Access to this office is no longer available');
    }

    const alive = await this.prisma.client.refreshSession.findFirst({
      where: { familyId: payload.sid, userId: payload.sub, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    if (!alive) throw unauthorized('SESSION_ENDED', 'Session has ended; please sign in again');

    const permissions = new Set<string>();
    for (const ur of membership.userRoles) {
      // A custom role must belong to this tenant; system roles have no tenant.
      if (ur.role.tenantId !== null && ur.role.tenantId !== payload.tid) continue;
      for (const rp of ur.role.permissions) permissions.add(rp.permission.code);
    }

    const auth: AuthContext = {
      userId: membership.user.id,
      email: membership.user.email,
      tenantId: payload.tid,
      membershipId: membership.id,
      sessionId: payload.sid,
      permissions,
    };
    req.auth = auth;
    return true;
  }
}

/** Default-deny: a route must be @Public, @Authenticated or declare @RequirePermissions. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  private readonly logger = new Logger(PermissionsGuard.name);

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth) throw unauthorized('UNAUTHENTICATED', 'Authentication required');

    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, targets);
    if (required && required.length > 0) {
      const missing = required.filter((p) => !auth.permissions.has(p));
      if (missing.length > 0) throw forbidden('PERMISSION_DENIED', 'You do not have permission to perform this action');
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_KEY, targets)) return true;

    this.logger.error(`Route ${req.method} ${req.path} has no access declaration; denying`);
    throw forbidden('ROUTE_NOT_CONFIGURED', 'This endpoint is not available');
  }
}

/** Runs the handler inside the tenant context so TenantDbService resolves the right tenant. */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.auth;
    if (!auth) return next.handle();
    return new Observable((subscriber) =>
      runWithTenant({ tenantId: auth.tenantId, userId: auth.userId }, () => next.handle().subscribe(subscriber)),
    );
  }
}
