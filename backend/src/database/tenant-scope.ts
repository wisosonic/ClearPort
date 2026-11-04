import { Prisma, type PrismaClient } from '../generated/prisma/client';

/**
 * Tenant-scoping Prisma extension (SQLite has no Row-Level Security, so this is the
 * application-layer isolation required by spec 9.2). Every query made through a tenant client
 * is forced to the tenant it was created for:
 *
 *  - reads / updates / deletes get `tenantId = <tenant>` added to the filter
 *  - creates get `tenantId` injected (a different explicit value is rejected)
 *  - "mixed" models (roles, document types, ...) also expose system rows (tenantId NULL) for
 *    reads, but system rows can never be modified through a tenant client
 *  - global/identity models (users, tenants, sessions) are not reachable at all
 *
 * Composite foreign keys (see schema) are the second line of defence for nested writes.
 * Raw SQL ($queryRaw / $executeRaw) bypasses this extension and must never be used with
 * user-influenced tenant values.
 */

/** Models whose tenantId is NOT NULL. */
const STRICT_MODELS = new Set([
  'TenantUser', 'Branch', 'UserRole', 'Client', 'ClientContact', 'BusinessParty', 'ClearanceFile',
  'NumberSequence', 'Shipment', 'Container', 'GoodsItem', 'Document', 'DocumentVersion',
  'DocumentRequirement', 'WorkflowTemplate', 'WorkflowStage', 'WorkflowTransition',
  'FileStatusHistory', 'Task', 'FileActivity', 'Notification', 'ExchangeRate', 'FinancialCategory',
  'Expense', 'Invoice', 'InvoiceItem', 'Payment', 'PaymentAllocation', 'CashAccount',
  'ChartOfAccount', 'JournalEntry', 'JournalEntryLine', 'AuditLog', 'Job',
]);

/** Models with tenantId NULL = system default (readable by every tenant, writable by none). */
const MIXED_MODELS = new Set(['Role', 'DocumentType', 'SystemSetting', 'NotificationTemplate']);

/** Identity models: must be accessed through the root client by auth code, never per-tenant. */
const FORBIDDEN_MODELS = new Set(['User', 'Tenant', 'RefreshSession']);

const WHERE_UNIQUE_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'update', 'delete']);
const WHERE_MANY_OPS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'count', 'aggregate', 'groupBy',
  'updateMany', 'updateManyAndReturn', 'deleteMany',
]);

export class TenantScopeViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantScopeViolation';
  }
}

function assertNotForeign(data: any, tenantId: string, where: string) {
  if (data && typeof data === 'object' && 'tenantId' in data && data.tenantId !== undefined && data.tenantId !== tenantId) {
    throw new TenantScopeViolation(`Refusing to write a different tenantId (${where})`);
  }
  if (data && typeof data === 'object' && 'tenant' in data) {
    throw new TenantScopeViolation(`Relation-style 'tenant' input is not allowed (${where})`);
  }
}

export function tenantScope(tenantId: string) {
  return Prisma.defineExtension({
    name: `tenant-scope:${tenantId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: any) {
          if (FORBIDDEN_MODELS.has(model)) {
            throw new TenantScopeViolation(`Model ${model} cannot be accessed through a tenant-scoped client`);
          }
          const strict = STRICT_MODELS.has(model);
          const mixed = MIXED_MODELS.has(model);
          if (!strict && !mixed) return query(args); // global reference data

          const a = args ?? {};

          // ── writes: never touch system rows, always stamp / filter by tenant ──
          if (operation === 'create') {
            assertNotForeign(a.data, tenantId, `${model}.create`);
            a.data = { ...a.data, tenantId };
          } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
            const rows = Array.isArray(a.data) ? a.data : [a.data];
            rows.forEach((r: any) => assertNotForeign(r, tenantId, `${model}.${operation}`));
            const stamped = rows.map((r: any) => ({ ...r, tenantId }));
            a.data = Array.isArray(a.data) ? stamped : stamped[0];
          } else if (operation === 'upsert') {
            assertNotForeign(a.create, tenantId, `${model}.upsert.create`);
            assertNotForeign(a.update, tenantId, `${model}.upsert.update`);
            a.create = { ...a.create, tenantId };
            a.where = { ...a.where, tenantId };
          } else if (operation === 'update' || operation === 'updateMany' || operation === 'updateManyAndReturn') {
            assertNotForeign(a.data, tenantId, `${model}.${operation}`);
          }

          if (operation === 'upsert' || operation === 'create' || operation === 'createMany' || operation === 'createManyAndReturn') {
            return query(a);
          }

          const isWrite = ['update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany'].includes(operation);

          // ── filters ──
          if (WHERE_UNIQUE_OPS.has(operation)) {
            if (a.where?.tenantId !== undefined && a.where.tenantId !== tenantId) {
              throw new TenantScopeViolation(`Refusing a different tenantId filter (${model}.${operation})`);
            }
            if (mixed && !isWrite) {
              // unique read of a mixed model: fetch, then allow own-tenant or system rows only
              const row = await query(a);
              if (row && row.tenantId !== null && row.tenantId !== tenantId) {
                if (operation === 'findUniqueOrThrow') throw new Prisma.PrismaClientKnownRequestError('Record not found', { code: 'P2025', clientVersion: Prisma.prismaVersion.client });
                return null;
              }
              return row;
            }
            a.where = { ...a.where, tenantId };
            return query(a);
          }

          if (WHERE_MANY_OPS.has(operation)) {
            const scope = mixed && !isWrite ? { OR: [{ tenantId }, { tenantId: null }] } : { tenantId };
            a.where = a.where ? { AND: [a.where, scope] } : scope;
            return query(a);
          }

          return query(a);
        },
      },
    },
  });
}

export function createTenantClient(prisma: PrismaClient, tenantId: string) {
  return prisma.$extends(tenantScope(tenantId));
}

export type TenantClient = ReturnType<typeof createTenantClient>;
