import { z } from 'zod';
import { listQuerySchema } from '../../common/pagination';
import { money } from '../../common/money';
import { optText } from '../../common/zod-helpers';

export { optText };

const countryCode = z
  .string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code')
  .nullable();

const emailField = z.string().trim().toLowerCase().email().max(150);

/** Non-negative decimal string, normalised to 4 decimals. */
const nonNegativeMoney = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    const s = String(v).trim();
    if (!/^\d+(\.\d{1,4})?$/.test(s)) {
      ctx.addIssue({ code: 'custom', message: 'Must be a non-negative amount with at most 4 decimals' });
      return z.NEVER;
    }
    return money(s);
  });

export const clientCodeSchema = z
  .string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Letters, digits, - and _ only').min(1).max(30);

export const contactInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  position: optText(100).optional(),
  phone: optText(50).optional(),
  email: emailField.optional(),
  isPrimary: z.boolean().optional(),
});

export const createClientSchema = z.object({
  /** Optional: generated (CLT-00001) when omitted. */
  clientCode: clientCodeSchema.optional(),
  clientType: z.enum(['COMPANY', 'INDIVIDUAL']).default('COMPANY'),
  name: z.string().trim().min(1).max(200),
  legalName: optText(200).optional(),
  taxNumber: optText(100).optional(),
  registrationNumber: optText(100).optional(),
  phone: optText(50).optional(),
  email: emailField.optional(),
  address: optText(500).optional(),
  countryCode: countryCode.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  creditLimit: nonNegativeMoney.nullable().optional(),
  notes: optText(2000).optional(),
  contacts: z.array(contactInputSchema).max(20).optional(),
});
export type CreateClientInput = z.infer<typeof createClientSchema>;

// clientCode is an identifier printed on documents; it cannot be changed after creation.
export const updateClientSchema = z.object({
  clientType: z.enum(['COMPANY', 'INDIVIDUAL']),
  name: z.string().trim().min(1).max(200),
  legalName: optText(200),
  taxNumber: optText(100),
  registrationNumber: optText(100),
  phone: optText(50),
  email: emailField.nullable(),
  address: optText(500),
  countryCode,
  paymentTermsDays: z.number().int().min(0).max(365),
  creditLimit: nonNegativeMoney.nullable(),
  notes: optText(2000),
  isActive: z.boolean(),
}).partial().strict();
export type UpdateClientInput = z.infer<typeof updateClientSchema>;

export const updateContactSchema = contactInputSchema
  .extend({ email: emailField.nullable() })
  .partial()
  .strict();

export const clientListQuerySchema = listQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  clientType: z.enum(['COMPANY', 'INDIVIDUAL']).optional(),
  countryCode: z.string().trim().toUpperCase().length(2).optional(),
});

export const PARTY_TYPES = ['SHIPPING_AGENT', 'FREIGHT_FORWARDER', 'SUPPLIER', 'TRANSPORTER', 'OTHER'] as const;

export const createPartySchema = z.object({
  name: z.string().trim().min(1).max(200),
  partyType: z.enum(PARTY_TYPES),
  taxNumber: optText(100).optional(),
  phone: optText(50).optional(),
  email: emailField.optional(),
  address: optText(500).optional(),
  countryCode: countryCode.optional(),
});
export const updatePartySchema = z.object({
  name: z.string().trim().min(1).max(200),
  partyType: z.enum(PARTY_TYPES),
  taxNumber: optText(100),
  phone: optText(50),
  email: emailField.nullable(),
  address: optText(500),
  countryCode,
}).partial().strict();
export const partyListQuerySchema = listQuerySchema.extend({
  partyType: z.enum(PARTY_TYPES).optional(),
});

export const clientFilesQuerySchema = listQuerySchema.extend({
  status: z.enum(['OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED']).optional(),
  fileType: z.enum(['IMPORT', 'EXPORT', 'OTHER']).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const statementQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  currency: z.string().trim().toUpperCase().length(3).optional(),
});
