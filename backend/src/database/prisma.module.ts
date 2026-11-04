import { Global, Inject, Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './client';
import { requireTenant } from './tenant-context';
import { createTenantClient, type TenantClient } from './tenant-scope';

/** Root (UNSCOPED) client. Only auth, provisioning, audit and workers may use it directly. */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private _client?: PrismaClient;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get client(): PrismaClient {
    if (!this._client) throw new Error('PrismaService not initialised');
    return this._client;
  }

  async onModuleInit() {
    this._client = await createPrismaClient(this.env.DATABASE_URL);
  }

  async onModuleDestroy() {
    await this._client?.$disconnect();
  }
}

/**
 * The client business modules use. It resolves the tenant from the request context that the
 * auth guard established, and returns a client that is forced to that tenant.
 */
@Injectable()
export class TenantDbService {
  private readonly cache = new Map<string, TenantClient>();

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  get client(): TenantClient {
    const { tenantId } = requireTenant();
    return this.forTenant(tenantId);
  }

  /** For workers / provisioning that know the tenant explicitly. */
  forTenant(tenantId: string): TenantClient {
    let c = this.cache.get(tenantId);
    if (!c) {
      c = createTenantClient(this.prisma.client, tenantId);
      this.cache.set(tenantId, c);
    }
    return c;
  }
}

@Global()
@Module({
  providers: [PrismaService, TenantDbService],
  exports: [PrismaService, TenantDbService],
})
export class DatabaseModule {}
