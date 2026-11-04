import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from './auth.types';
import {
  AuthService, changePasswordSchema, loginSchema, refreshSchema, switchTenantSchema,
  type LoginInput,
} from './auth.service';
import { Authenticated, CurrentAuth, Public, ReqMeta } from './decorators';
import type { z } from 'zod';

// Strict per-IP limit on credential endpoints (spec 9.4). Read at request time so tests can tune it.
const authLimit = () => Number(process.env.RATE_LIMIT_AUTH ?? 10);
const AUTH_THROTTLE = { default: { limit: authLimit, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('login')
  login(@Body(new ZodPipe(loginSchema)) body: LoginInput, @ReqMeta() meta: RequestMeta) {
    return this.auth.login(body, meta);
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body(new ZodPipe(refreshSchema)) body: z.infer<typeof refreshSchema>, @ReqMeta() meta: RequestMeta) {
    return this.auth.refresh(body.refreshToken, meta);
  }

  @Authenticated()
  @HttpCode(204)
  @Post('logout')
  async logout(@CurrentAuth() auth: AuthContext, @ReqMeta() meta: RequestMeta) {
    await this.auth.logout(auth, meta);
  }

  @Authenticated()
  @Get('me')
  me(@CurrentAuth() auth: AuthContext) {
    return this.auth.me(auth);
  }

  @Authenticated()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(204)
  @Post('change-password')
  async changePassword(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.auth.changePassword(auth, body, meta);
  }

  @Authenticated()
  @Throttle(AUTH_THROTTLE)
  @HttpCode(200)
  @Post('switch-tenant')
  switchTenant(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(switchTenantSchema)) body: z.infer<typeof switchTenantSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.auth.switchTenant(auth, body.tenantSlug, meta);
  }
}
