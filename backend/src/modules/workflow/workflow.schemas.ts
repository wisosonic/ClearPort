import { z } from 'zod';
import { optText, uuid } from '../../common/zod-helpers';

const FILE_TYPES = ['IMPORT', 'EXPORT', 'OTHER'] as const;
const stageCode = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE').min(2).max(50);

export const createTemplateSchema = z.object({
  name: z.string().trim().min(2).max(150),
  fileType: z.enum(FILE_TYPES),
  description: optText(500).optional(),
});
export const updateTemplateSchema = z.object({
  name: z.string().trim().min(2).max(150),
  description: optText(500),
  /** Activating a template deactivates the other templates of the same file type. */
  isActive: z.boolean(),
}).partial().strict();

export const createStageSchema = z.object({
  code: stageCode,
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  /** Omit to append after the last stage. */
  sequence: z.number().int().min(1).max(1000).optional(),
  isTerminal: z.boolean().default(false),
});
export const updateStageSchema = z.object({
  nameEn: z.string().trim().min(1).max(100),
  nameAr: z.string().trim().min(1).max(100),
  isTerminal: z.boolean(),
}).partial().strict();

const transitionFlags = {
  requiredPermission: z.string().trim().min(3).max(100).nullable(),
  requiresDocumentCheck: z.boolean(),
  requiresApproval: z.boolean(),
  requiresReason: z.boolean(),
  requiredTaskCheck: z.boolean(),
};
export const createTransitionSchema = z.object({
  fromStageId: uuid,
  toStageId: uuid,
  requiredPermission: transitionFlags.requiredPermission.optional(),
  requiresDocumentCheck: z.boolean().default(false),
  requiresApproval: z.boolean().default(false),
  requiresReason: z.boolean().default(false),
  requiredTaskCheck: z.boolean().default(false),
});
export const updateTransitionSchema = z.object(transitionFlags).partial().strict();

export const templateListQuerySchema = z.object({ fileType: z.enum(FILE_TYPES).optional() });

// ── moving a file ──

export const transitionSchema = z.object({
  toStageId: uuid.optional(),
  toStageCode: stageCode.optional(),
  reason: optText(1000).optional(),
}).strict().refine((v) => !!v.toStageId !== !!v.toStageCode, {
  message: 'Provide exactly one of toStageId or toStageCode',
  path: ['toStageId'],
});
export type TransitionInput = z.infer<typeof transitionSchema>;

export const closeSchema = z.object({
  note: optText(1000).optional(),
  /** Confirm closing although issued invoices are not fully paid. */
  acknowledgeOutstanding: z.boolean().default(false),
}).strict();
export const reopenSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
