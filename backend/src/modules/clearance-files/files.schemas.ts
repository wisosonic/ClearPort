import { z } from 'zod';
import { listQuerySchema } from '../../common/pagination';
import {
  countryCode, currencyCode, decimalString, isoDateTime, optText, uuid,
} from '../../common/zod-helpers';

const FILE_TYPES = ['IMPORT', 'EXPORT', 'OTHER'] as const;
const FILE_STATUSES = ['OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

// ───────────────────────────── clearance files ─────────────────────────────

export const createFileSchema = z.object({
  fileType: z.enum(FILE_TYPES),
  clientId: uuid,
  branchId: uuid.optional(),
  assignedTo: uuid.optional(),
  priority: z.enum(PRIORITIES).default('NORMAL'),
  expectedArrivalAt: isoDateTime.optional(),
  customsReference: optText(100).optional(),
  internalNotes: optText(5000).optional(),
});
export type CreateFileInput = z.infer<typeof createFileSchema>;

// Deliberately NOT editable here: fileNumber, fileType, status, currentStageId, closedAt, assignedTo.
// Stage changes go through POST /clearance-files/:id/transition (Phase 4) so workflow rules,
// permissions and document checks are enforced; assignment has its own endpoint.
export const updateFileSchema = z.object({
  clientId: uuid,
  branchId: uuid.nullable(),
  priority: z.enum(PRIORITIES),
  expectedArrivalAt: isoDateTime.nullable(),
  customsReference: optText(100),
  internalNotes: optText(5000),
}).partial().strict();
export type UpdateFileInput = z.infer<typeof updateFileSchema>;

export const assignSchema = z.object({ userId: uuid.nullable() }).strict();

export const fileListQuerySchema = listQuerySchema.extend({
  status: z.enum(FILE_STATUSES).optional(),
  fileType: z.enum(FILE_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  clientId: uuid.optional(),
  branchId: uuid.optional(),
  /** a user id, or "me" */
  assignedTo: z.union([uuid, z.literal('me'), z.literal('unassigned')]).optional(),
  stage: z.string().trim().max(60).optional(), // workflow stage code, e.g. DOCUMENT_COLLECTION
  openedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  openedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type FileListQuery = z.infer<typeof fileListQuerySchema>;

export const timelineQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

// ───────────────────────────── shipments ─────────────────────────────

const text = (max: number) => optText(max).optional();
const SHIPMENT_TYPES = ['SEA', 'AIR', 'LAND', 'OTHER'] as const;

const shipmentFields = {
  shipmentType: z.enum(SHIPMENT_TYPES),
  vesselName: optText(150),
  voyageNumber: optText(50),
  billOfLadingNumber: optText(60),
  masterBlNumber: optText(60),
  houseBlNumber: optText(60),
  shippingAgentId: uuid.nullable(),
  freightForwarderId: uuid.nullable(),
  originPortId: uuid.nullable(),
  destinationPortId: uuid.nullable(),
  etd: isoDateTime.nullable(),
  eta: isoDateTime.nullable(),
  actualArrivalAt: isoDateTime.nullable(),
  notes: optText(2000),
};

// A file may be created before shipment details are known, so every shipment field is optional.
export const createShipmentSchema = z.object({
  shipmentType: shipmentFields.shipmentType.default('SEA'),
  vesselName: text(150), voyageNumber: text(50), billOfLadingNumber: text(60),
  masterBlNumber: text(60), houseBlNumber: text(60),
  shippingAgentId: uuid.optional(), freightForwarderId: uuid.optional(),
  originPortId: uuid.optional(), destinationPortId: uuid.optional(),
  etd: isoDateTime.optional(), eta: isoDateTime.optional(), actualArrivalAt: isoDateTime.optional(),
  notes: text(2000),
});
export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;
export const updateShipmentSchema = z.object(shipmentFields).partial().strict();
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

// ───────────────────────────── containers ─────────────────────────────

const CONTAINER_STATUSES = ['PLANNED', 'AT_PORT', 'RELEASED', 'DELIVERED', 'RETURNED'] as const;
const containerFields = {
  containerNumber: z.string().trim().min(1).max(20),
  /** ISO 6346 is enforced unless the user explicitly confirms a non-standard number. */
  nonStandardNumber: z.boolean(),
  containerType: optText(20),
  sealNumber: optText(50),
  grossWeight: decimalString(3).nullable(),
  netWeight: decimalString(3).nullable(),
  packageCount: z.number().int().min(0).max(10_000_000).nullable(),
  status: z.enum(CONTAINER_STATUSES),
};
export const createContainerSchema = z.object({
  containerNumber: containerFields.containerNumber,
  nonStandardNumber: z.boolean().default(false),
  containerType: text(20), sealNumber: text(50),
  grossWeight: decimalString(3).optional(), netWeight: decimalString(3).optional(),
  packageCount: containerFields.packageCount.optional(),
  status: containerFields.status.default('PLANNED'),
});
export type CreateContainerInput = z.infer<typeof createContainerSchema>;
export const updateContainerSchema = z.object(containerFields).partial().strict();
export type UpdateContainerInput = z.infer<typeof updateContainerSchema>;

// ───────────────────────────── goods lines ─────────────────────────────

const goodsFields = {
  description: z.string().trim().min(1).max(2000),
  hsCodeId: uuid.nullable(),
  countryOfOrigin: countryCode.nullable(),
  quantity: decimalString(4).nullable(),
  unitOfMeasure: optText(20),
  grossWeight: decimalString(3).nullable(),
  netWeight: decimalString(3).nullable(),
  unitPrice: decimalString(4).nullable(),
  /** Ignored when quantity and unitPrice are both known: the server computes quantity x unitPrice. */
  lineTotal: decimalString(4).nullable(),
  currencyCode: currencyCode.nullable(),
};
export const createGoodsSchema = z.object({
  description: goodsFields.description,
  hsCodeId: uuid.optional(), countryOfOrigin: countryCode.optional(),
  quantity: decimalString(4).optional(), unitOfMeasure: text(20),
  grossWeight: decimalString(3).optional(), netWeight: decimalString(3).optional(),
  unitPrice: decimalString(4).optional(), lineTotal: decimalString(4).optional(),
  currencyCode: currencyCode.optional(),
});
export type CreateGoodsInput = z.infer<typeof createGoodsSchema>;
export const updateGoodsSchema = z.object(goodsFields).partial().strict();
export type UpdateGoodsInput = z.infer<typeof updateGoodsSchema>;

// ───────────────────────────── reference lookups ─────────────────────────────

export const portQuerySchema = listQuerySchema.extend({
  countryCode: z.string().trim().toUpperCase().length(2).optional(),
  portType: z.enum(['SEA', 'AIR', 'LAND', 'OTHER']).optional(),
});
export const hsCodeQuerySchema = listQuerySchema.extend({
  jurisdiction: z.string().trim().toUpperCase().max(10).optional(),
});
