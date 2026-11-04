import 'dotenv/config';
import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { loadEnv } from '../config/env';
import { ProvisioningService, provisionTenantSchema } from '../modules/tenants/provisioning.service';
import { seedReferenceData } from '../seed/reference-data';
import { PrismaService } from '../database/prisma.module';

/**
 * Creates a customs office and its Owner.
 *
 *   npm run tenant:create -w backend -- --name "Beirut Clearance Co" --slug beirut-clearance \
 *     --owner-email owner@example.com --owner-first Layla --owner-last Haddad
 *
 * The password is read from CLEARPORT_OWNER_PASSWORD (not a CLI flag, so it does not end up in
 * shell history or process listings).
 */
async function main() {
  const { values } = parseArgs({
    options: {
      name: { type: 'string' }, slug: { type: 'string' }, 'legal-name': { type: 'string' },
      currency: { type: 'string' }, locale: { type: 'string' }, timezone: { type: 'string' },
      'owner-email': { type: 'string' }, 'owner-first': { type: 'string' }, 'owner-last': { type: 'string' },
    },
  });
  const input = provisionTenantSchema.parse({
    name: values.name, slug: values.slug, legalName: values['legal-name'],
    defaultCurrency: values.currency, locale: values.locale, timezone: values.timezone,
    ownerEmail: values['owner-email'], ownerFirstName: values['owner-first'], ownerLastName: values['owner-last'],
    ownerPassword: process.env.CLEARPORT_OWNER_PASSWORD || undefined,
  });

  const app = await NestFactory.createApplicationContext(AppModule.register(loadEnv()), { logger: ['error'] });
  try {
    // Idempotent: makes sure system roles / currencies exist before the first office is created.
    await seedReferenceData(app.get(PrismaService).client);
    const result = await app.get(ProvisioningService).createTenant(input);
    console.log('Office created:', result);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  if (e?.issues) console.error(JSON.stringify(e.issues, null, 2));
  process.exit(1);
});
