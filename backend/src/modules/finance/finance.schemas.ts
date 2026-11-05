import { z } from 'zod';
import { listQuerySchema } from '../../common/pagination';
import { currencyCode, decimalString, isoDateTime, optText, uuid } from '../../common/zod-helpers';

// ───────────────────────────── shared pieces ─────────────────────────────

/**
 * A business date. Accepts "2026-11-03" (stored at 12:00 UTC so no timezone can move the day) or a
 * full ISO timestamp with offset.
 */
export const businessDate = z.union([
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(`${s}T12:00:00Z`)), 'Invalid date')
    .transform((s) => new Date(`${s}T12:00:00.000Z`)),
  isoDateTime,
]);

const dayString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

/** Strictly positive amount with up to 4 decimals, as a fixed 4-dp string. */
export const positiveAmount = decimalString(4).refine((s) => Number(s) > 0, 'Must be greater than zero');
const positiveRate = decimalString(10).refine((s) => Number(s) > 0, 'Must be greater than zero');
const convention = z.enum(['BASE_PER_FOREIGN', 'FOREIGN_PER_BASE']);

/** Optional manual exchange-rate override carried by a transaction. */
const rateOverride = {
  exchangeRate: positiveRate.optional(),
  rateConvention: convention.optional(),
  rateSource: optText(100).optional(),
};

// ───────────────────────────── rates, categories, tax, cash, accounts ─────────────────────────────

export const createRateSchema = z.object({
  currency: currencyCode,
  rate: positiveRate,
  /** Defaults by currency: 0-decimal currencies (LBP) use FOREIGN_PER_BASE, others BASE_PER_FOREIGN. */
  convention: convention.optional(),
  effectiveAt: isoDateTime.optional(),
  source: optText(100).optional(),
});
export const rateListQuerySchema = z.object({ currency: currencyCode.optional() });
export const latestRateQuerySchema = z.object({ currency: currencyCode, date: dayString.optional() });

export const createCategorySchema = z.object({
  name: z.string().trim().min(2).max(100),
  categoryType: z.enum(['CUSTOMS_DUTY_TAX', 'PORT_FEE', 'SHIPPING_FEE', 'TRANSPORTATION', 'SERVICE_FEE', 'INSPECTION', 'STORAGE', 'OTHER']),
  /** PASS_THROUGH: paid for the client and re-billed at cost. OFFICE_EXPENSE: the office's own cost. OFFICE_REVENUE: a fee the office earns. */
  costTreatment: z.enum(['PASS_THROUGH', 'OFFICE_EXPENSE', 'OFFICE_REVENUE']),
  isBillableToClient: z.boolean().default(true),
  isTaxable: z.boolean().default(false),
});
export const updateCategorySchema = z.object({
  name: z.string().trim().min(2).max(100),
  isBillableToClient: z.boolean(),
  isTaxable: z.boolean(),
  isActive: z.boolean(),
}).partial().strict(); // categoryType and costTreatment are fixed once transactions may rely on them

export const taxSettingsSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(30).default('VAT'),
  /** percent, e.g. "11" for 11 %. Entered by the office; never hardcoded (spec 4). */
  ratePercent: decimalString(4).refine((s) => Number(s) <= 100, 'Cannot exceed 100'),
}).strict();

export const createCashAccountSchema = z.object({
  name: z.string().trim().min(2).max(100),
  accountType: z.enum(['CASHBOX', 'BANK', 'OTHER']),
  currencyCode,
});
export const updateCashAccountSchema = z.object({ name: z.string().trim().min(2).max(100), isActive: z.boolean() }).partial().strict();

export const createAccountSchema = z.object({
  accountCode: z.string().trim().regex(/^[0-9]{3,10}$/, '3-10 digits'),
  name: z.string().trim().min(2).max(150),
  accountType: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']),
  parentId: uuid.optional(),
  currencyCode: currencyCode.optional(),
});
export const updateAccountSchema = z.object({ name: z.string().trim().min(2).max(150), isActive: z.boolean() }).partial().strict();

// ───────────────────────────── journal ─────────────────────────────

export const journalLineSchema = z.object({
  accountCode: z.string().trim().min(3).max(10),
  debit: positiveAmount.optional(),
  credit: positiveAmount.optional(),
  currencyCode,
  ...rateOverride,
  clearanceFileId: uuid.optional(),
}).refine((l) => (l.debit === undefined) !== (l.credit === undefined), { message: 'Give exactly one of debit or credit' });

export const createJournalSchema = z.object({
  entryDate: businessDate,
  description: z.string().trim().min(3).max(500),
  lines: z.array(journalLineSchema).min(2).max(50),
});
export const reverseJournalSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const journalListQuerySchema = listQuerySchema.extend({
  from: dayString.optional(),
  to: dayString.optional(),
  status: z.enum(['DRAFT', 'POSTED', 'REVERSED']).optional(),
  sourceType: z.string().trim().toUpperCase().max(30).optional(),
  accountCode: z.string().trim().max(10).optional(),
  clearanceFileId: uuid.optional(),
});
/** Revalue foreign balances at the rates on file for `asOf` (default today). `preview` shows the effect without posting. */
export const revaluationSchema = z.object({ asOf: businessDate.optional(), preview: z.boolean().default(false) }).strict();
export const trialBalanceQuerySchema = z.object({ asOf: dayString.optional() });

// ───────────────────────────── expenses ─────────────────────────────

const expenseFields = {
  clearanceFileId: uuid,
  categoryId: uuid,
  vendorId: uuid,
  description: z.string().trim().min(1).max(500),
  amount: positiveAmount,
  currencyCode,
  expenseDate: businessDate,
};
export const createExpenseSchema = z.object({
  clearanceFileId: expenseFields.clearanceFileId.optional(),
  categoryId: expenseFields.categoryId,
  vendorId: expenseFields.vendorId.optional(),
  description: expenseFields.description,
  amount: expenseFields.amount,
  currencyCode: expenseFields.currencyCode,
  expenseDate: expenseFields.expenseDate.optional(),
  ...rateOverride,
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export const updateExpenseSchema = z.object({
  clearanceFileId: expenseFields.clearanceFileId.nullable(),
  categoryId: expenseFields.categoryId,
  vendorId: expenseFields.vendorId.nullable(),
  description: expenseFields.description,
  amount: expenseFields.amount,
  currencyCode: expenseFields.currencyCode,
  expenseDate: expenseFields.expenseDate,
  ...rateOverride,
}).partial().strict();
export type UpdateExpenseInput = z.infer<typeof updateExpenseSchema>;

/** Approving records the expense in the books. With a cash account it is paid at once; without, it becomes a payable. */
export const approveExpenseSchema = z.object({
  cashAccountId: uuid.optional(),
  paidAt: businessDate.optional(),
}).strict();
export const payExpenseSchema = z.object({ cashAccountId: uuid, paidAt: businessDate.optional() }).strict();
export const reasonSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

export const expenseListQuerySchema = listQuerySchema.extend({
  status: z.enum(['DRAFT', 'APPROVED', 'CANCELLED']).optional(),
  paymentStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']).optional(),
  clearanceFileId: uuid.optional(),
  categoryId: uuid.optional(),
  vendorId: uuid.optional(),
  from: dayString.optional(),
  to: dayString.optional(),
  /** true: already re-billed on an invoice; false: not yet re-billed */
  billed: z.enum(['true', 'false']).optional(),
});

// ───────────────────────────── invoices ─────────────────────────────

export const invoiceItemSchema = z.object({
  /** Optional when the line re-bills an expense (then the expense's description is used). */
  description: optText(500).optional(),
  categoryId: uuid.optional(),
  quantity: decimalString(4).refine((s) => Number(s) > 0, 'Must be greater than zero').optional(),
  unitPrice: decimalString(4).optional(),
  /** Re-bills this pass-through expense at cost: quantity 1, unit price = the expense amount. */
  expenseId: uuid.optional(),
});
export type InvoiceItemInput = z.infer<typeof invoiceItemSchema>;

export const createInvoiceSchema = z.object({
  clearanceFileId: uuid,
  invoiceType: z.enum(['ADVANCE', 'SUPPLEMENTARY', 'FINAL', 'STANDARD']).default('STANDARD'),
  /** Defaults to the office's base currency. */
  currencyCode: currencyCode.optional(),
  dueDate: businessDate.optional(),
  discount: decimalString(4).default('0.0000'),
  items: z.array(invoiceItemSchema).min(1).max(100),
});
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export const updateInvoiceSchema = z.object({
  invoiceType: z.enum(['ADVANCE', 'SUPPLEMENTARY', 'FINAL', 'STANDARD']),
  currencyCode,
  dueDate: businessDate.nullable(),
  discount: decimalString(4),
  items: z.array(invoiceItemSchema).min(1).max(100),
}).partial().strict();
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

export const issueInvoiceSchema = z.object({
  issueDate: businessDate.optional(),
  dueDate: businessDate.optional(),
  ...rateOverride,
}).strict();

export const invoiceListQuerySchema = listQuerySchema.extend({
  status: z.enum(['DRAFT', 'ISSUED', 'CANCELLED']).optional(),
  invoiceType: z.enum(['ADVANCE', 'SUPPLEMENTARY', 'FINAL', 'STANDARD']).optional(),
  clientId: uuid.optional(),
  clearanceFileId: uuid.optional(),
  from: dayString.optional(),
  to: dayString.optional(),
  /** true: issued and not fully paid */
  unpaid: z.enum(['true', 'false']).optional(),
  overdue: z.enum(['true', 'false']).optional(),
});

// ───────────────────────────── payments ─────────────────────────────

export const allocationInputSchema = z.object({
  invoiceId: uuid,
  /** Amount taken from the payment, in the PAYMENT's currency. */
  amount: positiveAmount,
  /**
   * Amount credited to the invoice, in the INVOICE's currency. Optional: when the currencies
   * differ it defaults to the converted amount; give it to record an agreed rate or to settle
   * the last few units exactly.
   */
  invoiceAmount: positiveAmount.optional(),
});
export type AllocationInput = z.infer<typeof allocationInputSchema>;

export const createPaymentSchema = z.object({
  clientId: uuid,
  clearanceFileId: uuid.optional(),
  /** CLIENT_PAYMENT and CLIENT_ADVANCE are money received; REFUND pays unapplied credit back. */
  paymentType: z.enum(['CLIENT_PAYMENT', 'CLIENT_ADVANCE', 'REFUND']),
  amount: positiveAmount,
  currencyCode,
  cashAccountId: uuid,
  paymentMethod: z.string().trim().toUpperCase().min(2).max(30),
  referenceNumber: optText(100).optional(),
  paymentDate: businessDate.optional(),
  /** For a CLIENT_ADVANCE: the ADVANCE invoice (request for funds) this money answers. It settles that request; the books are unchanged. */
  advanceInvoiceId: uuid.optional(),
  /** Apply (part of) the payment to invoices straight away. */
  allocations: z.array(allocationInputSchema).max(50).optional(),
  ...rateOverride,
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export const allocatePaymentSchema = z.object({ allocations: z.array(allocationInputSchema).min(1).max(50) }).strict();

export const paymentListQuerySchema = listQuerySchema.extend({
  clientId: uuid.optional(),
  clearanceFileId: uuid.optional(),
  paymentType: z.enum(['CLIENT_PAYMENT', 'CLIENT_ADVANCE', 'REFUND', 'SUPPLIER_PAYMENT', 'REIMBURSEMENT']).optional(),
  status: z.enum(['DRAFT', 'POSTED', 'CANCELLED', 'REVERSED']).optional(),
  cashAccountId: uuid.optional(),
  from: dayString.optional(),
  to: dayString.optional(),
  /** true: has money not yet applied to invoices */
  unallocated: z.enum(['true', 'false']).optional(),
});

// ───────────────────────────── reports ─────────────────────────────

export const reportQuerySchema = z.object({
  from: dayString.optional(),
  to: dayString.optional(),
  clientId: uuid.optional(),
  fileType: z.enum(['IMPORT', 'EXPORT', 'OTHER']).optional(),
  status: z.enum(['OPEN', 'ON_HOLD', 'CLOSED', 'CANCELLED']).optional(),
  assignedTo: uuid.optional(),
  branchId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

// ───────────────────────────── operational reports and export (Phase 6) ─────────────────────────────

export const opsReportQuerySchema = reportQuerySchema.extend({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  categoryId: uuid.optional(),
  vendorId: uuid.optional(),
  clearanceFileId: uuid.optional(),
  /** expenses report: DRAFT / APPROVED / CANCELLED (default APPROVED) */
  expenseStatus: z.enum(['DRAFT', 'APPROVED', 'CANCELLED']).optional(),
  /** revenue report grouping */
  groupBy: z.enum(['month', 'client']).default('month'),
  /** client-balances: hide clients with nothing outstanding or held */
  onlyOpen: z.enum(['true', 'false']).default('true'),
});
export type OpsReportQuery = z.infer<typeof opsReportQuerySchema>;

export const exportQuerySchema = opsReportQuerySchema.extend({
  report: z.enum(['clearance-files', 'client-balances', 'expenses', 'revenue', 'employee-performance', 'profitability', 'financial-summary', 'trial-balance']),
  format: z.enum(['xlsx', 'csv', 'pdf']).default('xlsx'),
  locale: z.enum(['en', 'ar']).default('en'),
});
export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const dashboardQuerySchema = z.object({
  /** "stale" files have had no activity for this many days */
  staleDays: z.coerce.number().int().min(1).max(365).default(7),
  arrivingWithinDays: z.coerce.number().int().min(1).max(60).default(7),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const recentActivityQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) });
