import Decimal from 'decimal.js';
import { add, compare, money, percentOf, sub, sum, ZERO, type DecimalString } from '../../common/money';

export type CostTreatment = 'PASS_THROUGH' | 'OFFICE_REVENUE';

export interface TotalsInput {
  amount: DecimalString; // quantity x unit price (already rounded)
  treatment: CostTreatment;
  taxable: boolean;
}

export interface TotalsItem {
  amount: DecimalString;
  /** the item's share of the invoice discount (revenue items only) */
  discountShare: DecimalString;
  /** amount after discount: what is actually earned (revenue) or re-billed (pass-through) */
  net: DecimalString;
  taxRate: DecimalString;
  taxAmount: DecimalString;
}

export interface InvoiceTotals {
  items: TotalsItem[];
  subtotal: DecimalString;
  discount: DecimalString;
  taxAmount: DecimalString;
  total: DecimalString;
  /** ledger split of the total: AR debit = revenue + passThrough + tax */
  revenue: DecimalString;
  passThrough: DecimalString;
}

export class DiscountTooLargeError extends Error {
  constructor(public readonly maxDiscount: DecimalString) {
    super(`Discount exceeds the service-fee total (${maxDiscount})`);
  }
}

/**
 * Pure calculation of an invoice's totals (spec 6.4). No I/O, so every rule is unit-testable.
 *
 *  - subtotal  = sum of line amounts
 *  - discount  = a pre-tax reduction taken from SERVICE-FEE (revenue) lines only, spread pro-rata
 *                by amount (rounding remainder goes to the largest revenue line). Pass-through
 *                disbursements are re-billed at cost and are never discounted.
 *  - tax       = ratePercent x (line amount - its discount share), for lines whose category is taxable
 *  - total     = subtotal - discount + tax
 *
 * Ledger split: AR (total) = revenue + passThrough + tax, exactly, by construction.
 */
export function computeInvoiceTotals(items: TotalsInput[], discount: DecimalString, taxRatePercent: DecimalString | null): InvoiceTotals {
  const revenueIdx = items.map((it, i) => (it.treatment === 'OFFICE_REVENUE' ? i : -1)).filter((i) => i >= 0);
  const revenueSubtotal = sum(revenueIdx.map((i) => items[i].amount));
  const disc = money(discount);
  if (compare(disc, revenueSubtotal) > 0) throw new DiscountTooLargeError(revenueSubtotal);

  // pro-rata discount shares over revenue lines
  const shares = new Array<DecimalString>(items.length).fill(ZERO);
  if (compare(disc, ZERO) > 0 && revenueIdx.length > 0) {
    let allocated = ZERO;
    for (const i of revenueIdx) {
      shares[i] = money(new Decimal(disc).times(items[i].amount).div(revenueSubtotal));
      allocated = add(allocated, shares[i]);
    }
    const remainder = sub(disc, allocated);
    if (compare(remainder, ZERO) !== 0) {
      const largest = revenueIdx.reduce((a, b) => (compare(items[b].amount, items[a].amount) > 0 ? b : a));
      shares[largest] = add(shares[largest], remainder);
    }
  }

  const rate = taxRatePercent ?? '0';
  const out: TotalsItem[] = items.map((it, i) => {
    const net = sub(it.amount, shares[i]);
    const applies = it.taxable && compare(rate, ZERO) > 0;
    return {
      amount: it.amount, discountShare: shares[i], net,
      taxRate: applies ? money(rate) : ZERO, taxAmount: applies ? percentOf(net, rate) : ZERO,
    };
  });

  const subtotal = sum(items.map((it) => it.amount));
  const taxAmount = sum(out.map((o) => o.taxAmount));
  const revenue = sum(revenueIdx.map((i) => out[i].net));
  const passThrough = sum(items.map((it, i) => (it.treatment === 'PASS_THROUGH' ? out[i].net : ZERO)));
  const total = add(sub(subtotal, disc), taxAmount);
  return { items: out, subtotal, discount: disc, taxAmount, total, revenue, passThrough };
}
