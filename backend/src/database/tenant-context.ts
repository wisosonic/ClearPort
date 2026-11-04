import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The tenant on whose behalf the current request / job is running. It is established ONLY
 * from a verified membership (the auth guard) or explicitly by a worker. It is never taken
 * from a client-supplied tenant id.
 */
export interface TenantContext {
  tenantId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<TenantContext>();

export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentTenant(): TenantContext | undefined {
  return storage.getStore();
}

export class NoTenantContextError extends Error {
  constructor() {
    super('Tenant-scoped database access attempted without a tenant context');
    this.name = 'NoTenantContextError';
  }
}

export function requireTenant(): TenantContext {
  const ctx = storage.getStore();
  if (!ctx) throw new NoTenantContextError();
  return ctx;
}
