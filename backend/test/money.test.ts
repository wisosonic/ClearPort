import { describe, expect, it } from 'vitest';
import { add, compare, isPositive, money, mul, rate, sub, sum, toBase } from '../src/common/money';

describe('money helpers (decimal strings, never floats)', () => {
  it('avoids binary floating point errors', () => {
    expect(add('0.1000', '0.2000')).toBe('0.3000'); // 0.1 + 0.2 !== 0.3 with floats
    expect(sum(['0.1', '0.2', '0.3'])).toBe('0.6000');
  });

  it('normalises to 4 decimals for money and 10 for rates', () => {
    expect(money('1000')).toBe('1000.0000');
    expect(money('1.23456')).toBe('1.2346');
    expect(rate('89500')).toBe('89500.0000000000');
  });

  it('handles very large LBP amounts exactly', () => {
    expect(add('89500000000.0001', '0.0001')).toBe('89500000000.0002');
    expect(mul('1000', '89500')).toBe('89500000.0000');
  });

  it('subtracts and compares', () => {
    expect(sub('1000.0000', '250.5000')).toBe('749.5000');
    expect(compare('10.0000', '10')).toBe(0);
    expect(compare('9.9999', '10')).toBe(-1);
    expect(isPositive('0.0001')).toBe(true);
    expect(isPositive('0')).toBe(false);
  });

  it('converts to base currency honouring the rate convention', () => {
    expect(toBase('500', '89500', 'BASE_PER_FOREIGN')).toBe('44750000.0000');
    expect(toBase('44750000', '89500', 'FOREIGN_PER_BASE')).toBe('500.0000');
  });

  it('rejects malformed values and non-positive rates', () => {
    expect(() => money('12,50')).toThrow();
    expect(() => money('abc')).toThrow();
    expect(() => rate('0')).toThrow();
    expect(() => rate('-1')).toThrow();
    expect(() => toBase('1', '0')).toThrow();
  });

  it('rejects amounts beyond NUMERIC(20,4) precision', () => {
    expect(() => money('99999999999999999')).toThrow(/precision/);
  });
});
