export type InvoiceType = 'ADVANCE' | 'SUPPLEMENTARY' | 'FINAL' | 'STANDARD';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CANCELLED';
export const INVOICE_TYPES: InvoiceType[] = ['STANDARD', 'ADVANCE', 'SUPPLEMENTARY', 'FINAL'];

export interface InvoiceItem {
  id: string; description: string; categoryId: string | null; category: { id: string; name: string } | null;
  quantity: string; unitPrice: string; amount: string; taxAmount: string; expenseId: string | null;
}

export interface Invoice {
  id: string; invoiceNumber: string; invoiceType: InvoiceType; status: InvoiceStatus; currencyCode: string;
  issueDate: string | null; dueDate: string | null; cancelReason: string | null;
  subtotal: string; discount: string; taxAmount: string; totalAmount: string;
  paidAmount: string; outstandingAmount: string; paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | null; isOverdue: boolean;
  items?: InvoiceItem[];
}

export interface Currency { code: string; name: string; decimalPlaces: number }
export interface Category { id: string; name: string; costTreatment: 'PASS_THROUGH' | 'OFFICE_EXPENSE' | 'OFFICE_REVENUE'; isBillableToClient: boolean; isActive: boolean }
export interface BillableExpense {
  id: string; description: string; amount: string; currencyCode: string;
  category?: { id: string; name: string; costTreatment: string } | null;
}

/** A line as edited in the form: a service fee typed by the user, or a re-billed expense picked from the file's own. */
export type LineDraft =
  | { kind: 'service'; description: string; categoryId: string; quantity: string; unitPrice: string }
  | { kind: 'expense'; expenseId: string; description: string; amount: string };

export const AMOUNT = /^\d+(\.\d{1,4})?$/;
export const POSITIVE = (s: string) => AMOUNT.test(s.trim()) && Number(s) > 0;

/** "2026-11-03" for a date input from an ISO timestamp; dates are business days stored at 12:00 UTC. */
export const isoDay = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
