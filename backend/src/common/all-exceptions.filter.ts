import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { dbRuleViolation } from './db-errors';
import { DomainError } from './errors';
import { TenantScopeViolation } from '../database/tenant-scope';
import { NoTenantContextError } from '../database/tenant-context';

/** Centralised error rendering: { success:false, error:{ code, message, details } }. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, code, message, details } = this.normalise(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res.status(status).json({ success: false, error: { code, message, details } });
  }

  private normalise(e: unknown): { status: number; code: string; message: string; details: unknown[] } {
    if (e instanceof DomainError) {
      return { status: e.getStatus(), code: e.code, message: e.message, details: e.details };
    }
    if (e instanceof ZodError) {
      return {
        status: 400, code: 'VALIDATION_ERROR', message: 'Request validation failed',
        details: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      };
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const body = e.getResponse() as any;
      const message = typeof body === 'string' ? body : body?.message ?? e.message;
      const codeByStatus: Record<number, string> = {
        400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
        405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED',
      };
      return {
        status, code: body?.code ?? codeByStatus[status] ?? 'ERROR',
        message: Array.isArray(message) ? message.join('; ') : String(message), details: [],
      };
    }
    // Errors raised by Express middleware (body-parser: oversized or malformed JSON) carry their own 4xx status.
    const http = e as { status?: unknown; type?: string };
    if (typeof http?.status === 'number' && http.status >= 400 && http.status < 500 && typeof http.type === 'string') {
      const byType: Record<string, [string, string]> = {
        'entity.too.large': ['PAYLOAD_TOO_LARGE', 'Request body is too large'],
        'entity.parse.failed': ['BAD_REQUEST', 'Request body is not valid JSON'],
        'encoding.unsupported': ['BAD_REQUEST', 'Unsupported content encoding'],
        'charset.unsupported': ['BAD_REQUEST', 'Unsupported character set'],
      };
      const [code, message] = byType[http.type] ?? ['BAD_REQUEST', 'Bad request'];
      return { status: http.status, code, message, details: [] };
    }
    if (e instanceof TenantScopeViolation || e instanceof NoTenantContextError) {
      // A bug or an attack attempt — never leak details to the client.
      this.logger.error(`Tenant scope violation: ${(e as Error).message}`);
      return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] };
    }
    const rule = dbRuleViolation(e);
    if (rule) {
      return { status: 409, code: 'BUSINESS_RULE_VIOLATION', message: rule.message, details: [] };
    }
    const prismaCode = (e as any)?.code;
    if (prismaCode === 'P2002') {
      return { status: 409, code: 'DUPLICATE_RECORD', message: 'A record with the same unique value already exists', details: [] };
    }
    if (prismaCode === 'P2025') {
      return { status: 404, code: 'NOT_FOUND', message: 'Record not found', details: [] };
    }
    if (prismaCode === 'P2003') {
      return { status: 409, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist or belongs to another office', details: [] };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'Internal server error', details: [] };
  }
}
