import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { uuid } from '../../common/zod-helpers';
import { ZodPipe } from '../../common/zod.pipe';
import type { AuthContext, RequestMeta } from '../auth/auth.types';
import { CurrentAuth, ReqMeta, RequirePermissions } from '../auth/decorators';
import { allocatePaymentSchema, createPaymentSchema, paymentListQuerySchema, reasonSchema } from './finance.schemas';
import { PaymentsService } from './payments.service';

const id = () => new ZodPipe(uuid);

@Controller('payments')
export class PaymentsController {
  constructor(@Inject(PaymentsService) private readonly payments: PaymentsService) {}

  @RequirePermissions('payments.view')
  @Get()
  list(@Query(new ZodPipe(paymentListQuerySchema)) q: z.infer<typeof paymentListQuerySchema>) {
    return this.payments.list(q);
  }

  /** Receives money (payment / advance) or pays back unapplied credit (refund). Posts to the ledger; optionally allocates at once. */
  @RequirePermissions('payments.create')
  @Post()
  create(@CurrentAuth() auth: AuthContext, @Body(new ZodPipe(createPaymentSchema)) body: z.infer<typeof createPaymentSchema>, @ReqMeta() meta: RequestMeta) {
    return this.payments.create(auth, body, meta);
  }

  @RequirePermissions('payments.view')
  @Get(':paymentId')
  get(@Param('paymentId', id()) paymentId: string) {
    return this.payments.get(paymentId);
  }

  @RequirePermissions('payments.create')
  @HttpCode(200)
  @Post(':paymentId/allocate')
  allocate(
    @CurrentAuth() auth: AuthContext, @Param('paymentId', id()) paymentId: string,
    @Body(new ZodPipe(allocatePaymentSchema)) body: z.infer<typeof allocatePaymentSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.allocate(auth, paymentId, body.allocations, meta);
  }

  @RequirePermissions('payments.create')
  @HttpCode(200)
  @Post(':paymentId/allocations/:allocationId/reverse')
  reverseAllocation(
    @CurrentAuth() auth: AuthContext, @Param('paymentId', id()) paymentId: string, @Param('allocationId', id()) allocationId: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.reverseAllocation(auth, paymentId, allocationId, body.reason, meta);
  }

  @RequirePermissions('payments.create')
  @HttpCode(200)
  @Post(':paymentId/cancel')
  cancel(
    @CurrentAuth() auth: AuthContext, @Param('paymentId', id()) paymentId: string,
    @Body(new ZodPipe(reasonSchema)) body: z.infer<typeof reasonSchema>, @ReqMeta() meta: RequestMeta,
  ) {
    return this.payments.cancel(auth, paymentId, body.reason, meta);
  }
}
