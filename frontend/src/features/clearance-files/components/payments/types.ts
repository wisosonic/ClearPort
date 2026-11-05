export type PaymentType = 'CLIENT_PAYMENT' | 'CLIENT_ADVANCE' | 'REFUND' | 'SUPPLIER_PAYMENT' | 'REIMBURSEMENT';
export type PaymentStatus = 'DRAFT' | 'POSTED' | 'CANCELLED' | 'REVERSED';
/** The types a clerk can record from a file; supplier payments and reimbursements belong to expenses. */
export const RECORDABLE: PaymentType[] = ['CLIENT_PAYMENT', 'CLIENT_ADVANCE', 'REFUND'];
/** Fallback list while the payment methods load from the API (GET /payment-methods). */
export const METHODS = ['CASH', 'BANK_TRANSFER', 'CHEQUE', 'CARD', 'OTHER'] as const;

export interface Allocation {
  id: string; invoiceId: string; invoice: { id: string; invoiceNumber: string; currencyCode: string; invoiceType: string };
  paymentAmount: string; allocatedAmount: string; currencyCode: string; reversedAt: string | null; reversalReason: string | null;
}
export interface Payment {
  id: string; paymentNumber: string; paymentType: PaymentType; status: PaymentStatus; amount: string; currencyCode: string;
  paymentDate: string; paymentMethod: string; referenceNumber: string | null;
  cashAccount: { id: string; name: string } | null; allocatedAmount: string; unallocatedAmount: string;
  allocations?: Allocation[];
}
export interface CashAccount { id: string; name: string; accountType: string; currencyCode: string; isActive: boolean }
export interface OpenInvoice { id: string; invoiceNumber: string; invoiceType: string; currencyCode: string; outstandingAmount: string; status: string }

export const AMOUNT = /^\d+(\.\d{1,4})?$/;
export const POSITIVE = (s: string) => AMOUNT.test(s.trim()) && Number(s) > 0;
export const today = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
