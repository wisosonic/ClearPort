import Decimal from 'decimal.js';

/**
 * Money and exchange rates are stored as TEXT decimal strings (SQLite has no exact decimal
 * type). NEVER use JavaScript numbers for them. All arithmetic goes through decimal.js.
 *
 * Precision (spec 6.1): money 20 digits / 4 decimals, rates 24 digits / 10 decimals.
 */
export type DecimalString = string;

export const MONEY_DP = 4;
export const RATE_DP = 10;

const MONEY_MAX_INTEGER_DIGITS = 16; // 20 total - 4 decimals
const RATE_MAX_INTEGER_DIGITS = 14; // 24 total - 10 decimals

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

function parse(value: DecimalString | Decimal): Decimal {
  if (value instanceof Decimal) return value;
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    throw new Error(`Invalid decimal string: ${String(value)}`);
  }
  return new Decimal(value);
}

function assertFits(d: Decimal, maxIntDigits: number, label: string) {
  if (d.abs().floor().toFixed(0).length > maxIntDigits) {
    throw new Error(`${label} exceeds supported precision`);
  }
}

export function money(value: DecimalString | Decimal): DecimalString {
  const d = parse(value);
  assertFits(d, MONEY_MAX_INTEGER_DIGITS, 'Money amount');
  return d.toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP).toFixed(MONEY_DP);
}

export function rate(value: DecimalString | Decimal): DecimalString {
  const d = parse(value);
  assertFits(d, RATE_MAX_INTEGER_DIGITS, 'Exchange rate');
  if (d.lte(0)) throw new Error('Exchange rate must be positive');
  return d.toDecimalPlaces(RATE_DP, Decimal.ROUND_HALF_UP).toFixed(RATE_DP);
}

export const add = (a: DecimalString, b: DecimalString) => money(parse(a).plus(parse(b)));
export const sub = (a: DecimalString, b: DecimalString) => money(parse(a).minus(parse(b)));
export const mul = (a: DecimalString, b: DecimalString) => money(parse(a).times(parse(b)));

export function sum(values: DecimalString[]): DecimalString {
  return money(values.reduce((acc, v) => acc.plus(parse(v)), new Decimal(0)));
}

/** -1, 0 or 1 */
export function compare(a: DecimalString, b: DecimalString): number {
  return parse(a).comparedTo(parse(b));
}

export const isZero = (a: DecimalString) => parse(a).isZero();
export const isPositive = (a: DecimalString) => parse(a).gt(0);

/**
 * Converts an amount to base currency using a stored rate.
 * BASE_PER_FOREIGN: base = amount * rate. FOREIGN_PER_BASE: base = amount / rate.
 */
export function toBase(
  amount: DecimalString,
  exchangeRate: DecimalString,
  convention: 'BASE_PER_FOREIGN' | 'FOREIGN_PER_BASE' = 'BASE_PER_FOREIGN',
): DecimalString {
  const a = parse(amount);
  const r = parse(exchangeRate);
  if (r.lte(0)) throw new Error('Exchange rate must be positive');
  return money(convention === 'BASE_PER_FOREIGN' ? a.times(r) : a.div(r));
}

/**
 * Inverse of toBase: converts a BASE-currency amount into a foreign currency using the same stored
 * rate and convention. (Division/multiplication use decimal.js, never JavaScript numbers.)
 */
export function fromBase(
  baseAmount: DecimalString,
  exchangeRate: DecimalString,
  convention: 'BASE_PER_FOREIGN' | 'FOREIGN_PER_BASE' = 'BASE_PER_FOREIGN',
): DecimalString {
  const b = parse(baseAmount);
  const r = parse(exchangeRate);
  if (r.lte(0)) throw new Error('Exchange rate must be positive');
  return money(convention === 'BASE_PER_FOREIGN' ? b.div(r) : b.times(r));
}

/** amount x percent / 100, rounded to money precision (half-up). */
export function percentOf(amount: DecimalString, percent: DecimalString): DecimalString {
  return money(parse(amount).times(parse(percent)).div(100));
}

export const isNegative = (a: DecimalString) => parse(a).lt(0);
export const negate = (a: DecimalString) => money(parse(a).neg());
export const abs = (a: DecimalString) => money(parse(a).abs());
export const min = (a: DecimalString, b: DecimalString) => (compare(a, b) <= 0 ? money(a) : money(b));
export const ZERO: DecimalString = '0.0000';
