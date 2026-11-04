import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';

/** Handlers may return this to add pagination meta to the envelope. */
export class Paginated<T> {
  constructor(
    public readonly items: T[],
    /** page / limit / total, plus optional report-wide extras (e.g. totals across all pages) */
    public readonly meta: { page: number; limit: number; total: number; [extra: string]: unknown },
  ) {}
}

/** Wraps every successful response as { success:true, data, meta? }. */
@Injectable()
export class EnvelopeInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((value) => {
        if (value instanceof Paginated) return { success: true, data: value.items, meta: value.meta };
        return { success: true, data: value === undefined ? null : value };
      }),
    );
  }
}
