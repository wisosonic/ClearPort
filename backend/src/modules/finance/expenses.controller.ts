import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { ExpensesService } from './expenses.service';
import {
  approveExpenseSchema, createExpenseSchema, expenseListQuerySchema, payExpenseSchema, reasonSchema, updateExpenseSchema,
} from './finance.schemas';

const id = () => new ZodPipe(uuid);

@Controller('expenses')
export class ExpensesController {
  constructor(@Inject(ExpensesService) private readonly expenses: ExpensesService) {}

  @RequirePermissions('expenses.view')
  @Get()
  list(@Query(new ZodPipe(expenseListQuerySchema)) q: z.infer<typeof expenseListQuerySchema>) {
    return this.expenses.list(q);
  }

  @RequirePermissions('expenses.create')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createExpenseSchema)) body: z.infer<typeof createExpenseSchema>, @ReqMeta() meta: RequestMeta) {
    return this.expenses.create(auth, body, meta);
  }

  @RequirePermissions('expenses.view')
  @Get(':expenseId')
  get(@Param('expenseId', id()) expenseId: string) {
    return this.expenses.get(expenseId);
  }

  @RequirePermissions('expenses.create')
  @Patch(':expenseId')
  update(
    @CurrentAuth() auth: AuthContext, @Param('expenseId', id()) expenseId: string,
    @Body(new ZodPipe(updateExpenseSchema)) body: z.infer<typeof updateExpenseSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.update(auth, expenseId, body, meta);
  }

  /** Approving posts the expense to the ledger (paid from a cash account, or as a payable). */
  @RequirePermissions('expenses.approve')
  @HttpCode(200)
  @Post(':expenseId/approve')
  approve(
    @CurrentAuth() auth: AuthContext, @Param('expenseId', id()) expenseId: string,
    @Body(new ZodPipe(approveExpenseSchema)) body: z.infer<typeof approveExpenseSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.approve(auth, expenseId, body, meta);
  }

  @RequirePermissions('expenses.approve')
  @HttpCode(200)
  @Post(':expenseId/pay')
  pay(
    @CurrentAuth() auth: AuthContext, @Param('expenseId', id()) expenseId: string,
    @Body(new ZodPipe(payExpenseSchema)) body: z.infer<typeof payExpenseSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.pay(auth, expenseId, body, meta);
  }

  @RequirePermissions('expenses.approve')
  @HttpCode(200)
  @Post(':expenseId/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext, @Param('expenseId', id()) expenseId: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.expenses.cancel(auth, expenseId, body.reason, meta);
  }
}
