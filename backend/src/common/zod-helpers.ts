import Decimal from 'decimal.js';
import { z } from 'zod';

/**
 * Trimmed text where "no value" is stored as NULL. Both an empty string (HTML forms) and an
 * explicit null (API clients) clear the field, so every optional text field behaves the same way.
 */
export const optText = (max: number) =>
  z.string().trim().max(max).nullable().transform((v) => (v === null || v === '' ? null : v));

export const uuid = z.string().uuid();

/** ISO 3166-1 alpha-2, upper-cased. */
export const countryCode = z
  .string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code');

/** ISO 4217 currency code, upper-cased. */
export const currencyCode = z
  .string().trim().toUpperCase().regex(/^[A-Z]{3}$/, 'ISO 4217 currency code');

/** ISO-8601 date-time with offset (e.g. 2026-11-15T10:00:00Z) → Date. */
export const isoDateTime = z
  .string().datetime({ offset: true })
  .transform((s) => new Date(s));

/**
 * Non-negative decimal accepted as string or number, at most `dp` decimals, returned as a
 * fixed-`dp` decimal STRING (SQLite stores exact decimals as TEXT — see money.ts).
 */
export const decimalString = (dp: number, maxIntegerDigits = 14) =>
  z.union([z.string(), z.number()]).transform((v, ctx) => {
    const s = String(v).trim();
    if (!new RegExp(`^\\d+(\\.\\d{1,${dp}})?$`).test(s)) {
      ctx.addIssue({ code: 'custom', message: `Must be a non-negative number with at most ${dp} decimals` });
      return z.NEVER;
    }
    const d = new Decimal(s);
    if (d.floor().toFixed(0).length > maxIntegerDigits) {
      ctx.addIssue({ code: 'custom', message: 'Number is too large' });
      return z.NEVER;
    }
    return d.toFixed(dp);
  });

/** An IANA time zone such as "Asia/Beirut". Anything the runtime does not know is refused, so date logic never meets a bad zone. */
export const timeZone = z.string().trim().max(50).refine((tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}, 'Unknown time zone (use a name such as Asia/Beirut)');
