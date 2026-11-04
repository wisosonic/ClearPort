import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { FilesService } from '../clearance-files/files.service';
import { createTaskSchema, taskListQuerySchema, updateTaskSchema } from './tasks.schemas';
import { TasksService } from './tasks.service';

const id = () => new ZodPipe(uuid);

@Controller()
export class TasksController {
  constructor(
    @Inject(TasksService) private readonly tasks: TasksService,
    @Inject(FilesService) private readonly files: FilesService,
  ) {}

  @RequirePermissions('tasks.view')
  @Get('tasks')
  list(@CurrentAuth() auth: AuthContext, @Query(new ZodPipe(taskListQuerySchema)) q: z.infer<typeof taskListQuerySchema>) {
    return this.tasks.list(auth, q);
  }

  @RequirePermissions('tasks.manage')
  @Post('tasks')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createTaskSchema)) body: z.infer<typeof createTaskSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tasks.create(auth, body, meta);
  }

  @RequirePermissions('tasks.view')
  @Get('tasks/:taskId')
  get(@Param('taskId', id()) taskId: string) {
    return this.tasks.get(taskId);
  }

  /** `tasks.view` here: the service lets assignees move their own task without `tasks.manage`. */
  @RequirePermissions('tasks.view')
  @Patch('tasks/:taskId')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('taskId', id()) taskId: string,
    @Body(new ZodPipe(updateTaskSchema)) body: z.infer<typeof updateTaskSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.tasks.update(auth, taskId, body, meta);
  }

  @RequirePermissions('tasks.view')
  @HttpCode(200)
  @Post('tasks/:taskId/complete')
  complete(@CurrentAuth() auth: AuthContext, @Param('taskId', id()) taskId: string, @ReqMeta() meta: RequestMeta) {
    return this.tasks.complete(auth, taskId, meta);
  }

  @RequirePermissions('tasks.view')
  @Get('clearance-files/:fileId/tasks')
  async fileTasks(
    @CurrentAuth() auth: AuthContext,
    @Param('fileId', id()) fileId: string,
    @Query(new ZodPipe(taskListQuerySchema)) q: z.infer<typeof taskListQuerySchema>,
  ) {
    await this.files.require(fileId);
    return this.tasks.list(auth, q, fileId);
  }

  @RequirePermissions('tasks.view')
  @Get('dashboard/my-tasks')
  myTasks(@CurrentAuth() auth: AuthContext) {
    return this.tasks.myTasks(auth);
  }
}
