import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import { uuid } from '../../common/zod-helpers';
import type { AuthContext } from '../auth/auth.types';
import { Authenticated, CurrentAuth } from '../auth/decorators';
import { NotificationsService } from './notifications.service';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  unread: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

/** A person's own notifications. There is no way to see anyone else's. */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(NotificationsService) private readonly notifications: NotificationsService) {}

  @Authenticated()
  @Get()
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    return this.notifications.list(auth, q);
  }

  @Authenticated()
  @HttpCode(200)
  @Post('read-all')
  readAll(@CurrentAuth() auth: AuthContext) {
    return this.notifications.markAllRead(auth);
  }

  @Authenticated()
  @HttpCode(204)
  @Post(':id/read')
  async read(@CurrentAuth() auth: AuthContext, @Param('id', new ZodPipe(uuid)) id: string) {
    await this.notifications.markRead(auth, id);
  }
}
