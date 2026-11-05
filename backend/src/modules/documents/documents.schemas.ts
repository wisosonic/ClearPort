import { z } from 'zod';
import { listQuerySchema } from '../../common/pagination';
import { optText, uuid } from '../../common/zod-helpers';

/** Text fields that arrive next to the file in the multipart body. */
export const uploadFieldsSchema = z.object({
  documentTypeId: uuid,
  notes: optText(1000).optional(),
});
export type UploadFields = z.infer<typeof uploadFieldsSchema>;

export const versionFieldsSchema = z.object({ notes: optText(1000).optional() });

export const documentStatusSchema = z.object({
  status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED']),
  note: optText(1000).optional(),
}).strict();

export const documentListQuerySchema = listQuerySchema.extend({
  clearanceFileId: uuid.optional(),
  documentTypeId: uuid.optional(),
  status: z.enum(['PENDING_REVIEW', 'APPROVED', 'REJECTED', 'VOID']).optional(),
  includeVoid: z.enum(['true', 'false']).optional(),
});

export const downloadQuerySchema = z.object({
  version: z.coerce.number().int().min(1).optional(),
  disposition: z.enum(['attachment', 'inline']).default('attachment'),
});

// ───────────────────────────── document types ─────────────────────────────

export const createDocumentTypeSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/).min(2).max(50),
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  description: optText(300).optional(),
});
export const updateDocumentTypeSchema = z.object({
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  description: optText(300),
  isActive: z.boolean(),
}).partial().strict();

// ───────────────────────────── requirements ─────────────────────────────

const FILE_TYPES = ['IMPORT', 'EXPORT', 'OTHER'] as const;

/**
 * When a requirement applies. Every key given must hold for the file; omit the whole object to always apply.
 *  - shipmentType: the file has a shipment of one of these types (SEA, AIR, LAND, OTHER)
 *  - hasContainers: true = the file has containers, false = it has none
 *  - priority: the file's priority is one of these
 *  - clientType: the client is a COMPANY or an INDIVIDUAL
 */
export const requirementConditionsSchema = z.object({
  shipmentType: z.array(z.enum(['SEA', 'AIR', 'LAND', 'OTHER'])).min(1).optional(),
  hasContainers: z.boolean().optional(),
  priority: z.array(z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT'])).min(1).optional(),
  clientType: z.enum(['COMPANY', 'INDIVIDUAL']).optional(),
}).strict();
export type RequirementConditions = z.infer<typeof requirementConditionsSchema>;
export const createRequirementSchema = z.object({
  fileType: z.enum(FILE_TYPES),
  documentTypeId: uuid,
  isRequired: z.boolean().default(true),
  /** Stage the document must exist before entering. Omit: required before the file reaches a terminal stage. */
  isRequiredBeforeStageId: uuid.optional(),
  appliesTo: optText(200).optional(),
  /** Omit to apply to every file of the type. */
  conditions: requirementConditionsSchema.optional(),
});
export const updateRequirementSchema = z.object({
  isRequired: z.boolean(),
  isRequiredBeforeStageId: uuid.nullable(),
  appliesTo: optText(200),
  conditions: requirementConditionsSchema.nullable(),
}).partial().strict();
export const requirementListQuerySchema = z.object({ fileType: z.enum(FILE_TYPES).optional() });
