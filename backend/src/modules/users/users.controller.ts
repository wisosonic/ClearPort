import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import {
  createUserSchema, updateUserSchema, userListQuerySchema, userStatusSchema, UsersService,
} from './users.service';

const uuid = z.string().uuid();

@Controller('users')
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @RequirePermissions('users.manage')
  @Get()
  list(@Query(new ZodPipe(userListQuerySchema)) q: z.infer<typeof userListQuerySchema>) {
    return this.users.list(q);
  }

  @RequirePermissions('users.manage')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createUserSchema)) body: z.infer<typeof createUserSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.create(auth, body, meta);
  }

  @RequirePermissions('users.manage')
  @Get(':id')
  get(@Param('id', new ZodPipe(uuid)) id: string) {
    return this.users.get(id);
  }

  @RequirePermissions('users.manage')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(updateUserSchema)) body: z.infer<typeof updateUserSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.update(auth, id, body, meta);
  }

  @RequirePermissions('users.manage')
  @Patch(':id/status')
  setStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ZodPipe(uuid)) id: string,
    @Body(new ZodPipe(userStatusSchema)) body: z.infer<typeof userStatusSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.users.setStatus(auth, id, body.isActive, meta);
  }
}
