import { HttpException } from '@nestjs/common';

/**
 * Domain error with a stable machine-readable code (spec 14: e.g. CLEARANCE_FILE_NOT_FOUND).
 * The exception filter renders it as { success:false, error:{ code, message, details } }.
 */
export class DomainError extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status: number,
    public readonly details: unknown[] = [],
  ) {
    super({ code, message, details }, status);
  }
}

export const notFound = (code: string, message: string) => new DomainError(code, message, 404);
export const conflict = (code: string, message: string, details: unknown[] = []) =>
  new DomainError(code, message, 409, details);
export const forbidden = (code: string, message: string) => new DomainError(code, message, 403);
export const unauthorized = (code: string, message: string) => new DomainError(code, message, 401);
export const badRequest = (code: string, message: string, details: unknown[] = []) =>
  new DomainError(code, message, 400, details);
export const unprocessable = (code: string, message: string, details: unknown[] = []) =>
  new DomainError(code, message, 422, details);
