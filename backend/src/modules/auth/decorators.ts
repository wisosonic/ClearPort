import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthContext, RequestMeta } from './auth.types';

export const IS_PUBLIC = 'clearport:public';
export const PERMISSIONS_KEY = 'clearport:permissions';
export const AUTHENTICATED_KEY = 'clearport:authenticated';

/** No authentication (login, refresh, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Caller must hold ALL listed permissions in the active tenant. Enforced by the backend for
 * every protected action (spec 9.3); hiding buttons in the UI is not security.
 */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

/** Any authenticated member of the tenant (e.g. GET /auth/me). Must be explicit: default is deny. */
export const Authenticated = () => SetMetadata(AUTHENTICATED_KEY, true);

export const CurrentAuth = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.auth) throw new Error('CurrentAuth used on a route without authentication');
  return req.auth;
});

export const ReqMeta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return { ip: req.ip, userAgent: req.headers['user-agent']?.slice(0, 300) };
});
