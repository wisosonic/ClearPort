import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import {
  clientFilesQuerySchema, clientListQuerySchema, contactInputSchema, createClientSchema,
  statementQuerySchema, updateClientSchema, updateContactSchema,
} from './clients.schemas';
import { ClientsService } from './clients.service';

const uuid = z.string().uuid();
const id = () => new ZodPipe(uuid);

@Controller('clients')
export class ClientsController {
  constructor(@Inject(ClientsService) private readonly clients: ClientsService) {}

  @RequirePermissions('clients.view')
  @Get()
  list(@Query(new ZodPipe(clientListQuerySchema)) q: z.infer<typeof clientListQuerySchema>) {
    return this.clients.list(q);
  }

  @RequirePermissions('clients.manage')
  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodPipe(createClientSchema)) body: z.infer<typeof createClientSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.clients.create(auth, body, meta);
  }

  @RequirePermissions('clients.view')
  @Get(':id')
  get(@Param('id', id()) clientId: string) {
    return this.clients.get(clientId);
  }

  @RequirePermissions('clients.manage')
  @Patch(':id')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) clientId: string,
    @Body(new ZodPipe(updateClientSchema)) body: z.infer<typeof updateClientSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.clients.update(auth, clientId, body, meta);
  }

  // ── contacts ──

  @RequirePermissions('clients.manage')
  @Post(':id/contacts')
  addContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) clientId: string,
    @Body(new ZodPipe(contactInputSchema)) body: z.infer<typeof contactInputSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.clients.addContact(auth, clientId, body, meta);
  }

  @RequirePermissions('clients.manage')
  @Patch(':id/contacts/:contactId')
  updateContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) clientId: string,
    @Param('contactId', id()) contactId: string,
    @Body(new ZodPipe(updateContactSchema)) body: z.infer<typeof updateContactSchema>,
    @ReqMeta() meta: RequestMeta,
  ) {
    return this.clients.updateContact(auth, clientId, contactId, body, meta);
  }

  @RequirePermissions('clients.manage')
  @HttpCode(204)
  @Delete(':id/contacts/:contactId')
  async removeContact(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) clientId: string,
    @Param('contactId', id()) contactId: string,
    @ReqMeta() meta: RequestMeta,
  ) {
    await this.clients.removeContact(auth, clientId, contactId, meta);
  }

  // ── history and money ──

  @RequirePermissions('clients.view', 'clearance_files.view')
  @Get(':id/files')
  files(
    @Param('id', id()) clientId: string,
    @Query(new ZodPipe(clientFilesQuerySchema)) q: z.infer<typeof clientFilesQuerySchema>,
  ) {
    return this.clients.files(clientId, q);
  }

  @RequirePermissions('clients.view', 'invoices.view', 'payments.view')
  @Get(':id/balance')
  balance(@Param('id', id()) clientId: string) {
    return this.clients.balance(clientId);
  }

  @RequirePermissions('clients.view', 'invoices.view', 'payments.view')
  @Get(':id/statement')
  statement(
    @Param('id', id()) clientId: string,
    @Query(new ZodPipe(statementQuerySchema)) q: z.infer<typeof statementQuerySchema>,
  ) {
    return this.clients.statement(clientId, q);
  }
}
