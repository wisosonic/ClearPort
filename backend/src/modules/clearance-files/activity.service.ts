import { Inject, Injectable } from '@nestjs/common';
import { TenantDbService } from '../../database/prisma.module';

/**
 * Human-readable business timeline of a clearance file (spec 11.5) — NOT the audit log.
 * Write one entry for every business event staff would want to read back ("Document uploaded",
 * "Employee assigned", "Stage changed", ...). `tx` lets callers write it in their transaction.
 */
@Injectable()
export class ActivityService {
  constructor(@Inject(TenantDbService) private readonly db: TenantDbService) {}

  async log(
    fileId: string, userId: string, activityType: string, description: string,
    metadata?: Record<string, unknown>, tx?: any,
  ) {
    const client = tx ?? this.db.client;
    await client.fileActivity.create({
      data: { clearanceFileId: fileId, userId, activityType, description, metadata: metadata as any },
    });
  }
}
