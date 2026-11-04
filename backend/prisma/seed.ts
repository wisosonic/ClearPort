import 'dotenv/config';
import { createPrismaClient } from '../src/database/client';
import { seedReferenceData } from '../src/seed/reference-data';

async function main() {
  const prisma = await createPrismaClient();
  try {
    await seedReferenceData(prisma);
    const [permissions, roles, currencies, types, ports] = await Promise.all([
      prisma.permission.count(), prisma.role.count({ where: { tenantId: null } }),
      prisma.currency.count(), prisma.documentType.count({ where: { tenantId: null } }),
      prisma.port.count(),
    ]);
    console.log({ permissions, systemRoles: roles, currencies, documentTypes: types, ports });
    console.log('Reference data seeded. Per-tenant defaults are created by provisionTenantDefaults().');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
