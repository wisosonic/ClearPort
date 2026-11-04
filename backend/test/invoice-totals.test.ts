import { describe, expect, it } from 'vitest';
import { add, compare, sub } from '../src/common/money';
import { computeInvoiceTotals, DiscountTooLargeError, type TotalsInput } from '../src/modules/finance/invoice-totals';

const rev = (amount: string, taxable = true): TotalsInput => ({ amount, treatment: 'OFFICE_REVENUE', taxable });
const pass = (amount: string, taxable = false): TotalsInput => ({ amount, treatment: 'PASS_THROUGH', taxable });

describe('invoice totals (pure calculation)', () => {
  it('re-bills pass-through at cost and taxes only taxable lines', () => {
    const t = computeInvoiceTotals([rev('1000.0000'), pass('500.0000')], '0', '11');
    expect(t).toMatchObject({ subtotal: '1500.0000', discount: '0.0000', taxAmount: '110.0000', total: '1610.0000', revenue: '1000.0000', passThrough: '500.0000' });
    expect(t.items.map((i) => [i.taxRate, i.taxAmount])).toEqual([['11.0000', '110.0000'], ['0.0000', '0.0000']]);
  });

  it('applies no tax when tax is off or the line is not taxable', () => {
    expect(computeInvoiceTotals([rev('1000')], '0', null).total).toBe('1000.0000');
    expect(computeInvoiceTotals([rev('1000')], '0', '0').taxAmount).toBe('0.0000');
    expect(computeInvoiceTotals([rev('1000', false)], '0', '11').taxAmount).toBe('0.0000');
  });

  it('takes the discount from service fees before tax', () => {
    const t = computeInvoiceTotals([rev('1000'), pass('500')], '100', '11');
    expect(t.revenue).toBe('900.0000'); // 1000 - 100
    expect(t.passThrough).toBe('500.0000'); // never discounted
    expect(t.taxAmount).toBe('99.0000'); // 11 % of 900
    expect(t.total).toBe('1499.0000'); // 1500 - 100 + 99
  });

  it('spreads the discount pro-rata over service-fee lines and keeps it exact', () => {
    const t = computeInvoiceTotals([rev('600'), rev('400'), pass('250')], '33.33', '10');
    expect(t.items.map((i) => i.discountShare)).toEqual(['19.9980', '13.3320', '0.0000']);
    expect(t.items.reduce((a, i) => add(a, i.discountShare), '0.0000')).toBe('33.3300');
    expect(t.discount).toBe('33.3300');
  });

  it('puts any rounding remainder on the largest service-fee line so shares always sum to the discount', () => {
    const t = computeInvoiceTotals([rev('500'), rev('500')], '0.0001', '0');
    const shares = t.items.map((i) => i.discountShare);
    expect(shares.reduce((a, s) => add(a, s), '0.0000')).toBe('0.0001');
    const odd = computeInvoiceTotals([rev('333.3333'), rev('333.3333'), rev('333.3334')], '100', '0');
    expect(odd.items.reduce((a, i) => add(a, i.discountShare), '0.0000')).toBe('100.0000');
  });

  it('rejects a discount larger than the service fees', () => {
    expect(() => computeInvoiceTotals([rev('100'), pass('900')], '150', '0')).toThrow(DiscountTooLargeError);
    expect(() => computeInvoiceTotals([pass('900')], '1', '0')).toThrow(DiscountTooLargeError); // nothing to discount
    expect(computeInvoiceTotals([rev('100')], '100', '0').total).toBe('0.0000'); // exactly the fees is fine
  });

  it('rounds each line\'s tax half-up to 4 decimals', () => {
    const t = computeInvoiceTotals([rev('0.0050')], '0', '11'); // 0.00055 -> 0.0006
    expect(t.items[0].taxAmount).toBe('0.0006');
    expect(computeInvoiceTotals([rev('33.3333')], '0', '11').taxAmount).toBe('3.6667'); // 3.666663
  });

  it('keeps the ledger identity total = revenue + passThrough + tax for any mix (property check)', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rnd() * 6);
      const items: TotalsInput[] = Array.from({ length: n }, () => {
        const amount = (rnd() * 5000).toFixed(4);
        return rnd() < 0.5 ? rev(amount, rnd() < 0.7) : pass(amount, rnd() < 0.2);
      });
      const revenueSubtotal = items.filter((i) => i.treatment === 'OFFICE_REVENUE').reduce((a, i) => add(a, i.amount), '0.0000');
      const discount = compare(revenueSubtotal, '0') > 0 ? (Number(revenueSubtotal) * rnd() * 0.5).toFixed(4) : '0';
      const rate = rnd() < 0.2 ? null : (rnd() * 25).toFixed(4);
      const t = computeInvoiceTotals(items, discount, rate);
      const ledger = add(add(t.revenue, t.passThrough), t.taxAmount);
      expect(t.total, `run ${run}`).toBe(ledger);
      expect(t.total).toBe(add(sub(t.subtotal, t.discount), t.taxAmount)); // total = subtotal - discount + tax
      expect(t.items.reduce((a, i) => add(a, i.discountShare), '0.0000')).toBe(t.discount);
    }
  });
});
