/**
 * ISO 6346 freight-container identification: 3-letter owner code + category letter (U, J or Z)
 * + 6-digit serial + 1 check digit, e.g. CSQU3054383.
 */

const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let value = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (value % 11 === 0) value++; // 11, 22, 33 are skipped
    map[ch] = value++;
  }
  return map;
})();

export const ISO6346_PATTERN = /^[A-Z]{3}[UJZ]\d{7}$/;

/** Upper-cases and removes spaces / hyphens commonly typed in container numbers ("MSKU 123456-5"). */
export function normalizeContainerNumber(raw: string): string {
  return raw.replace(/[\s-]/g, '').toUpperCase();
}

/** The check digit for the first 10 characters (owner + category + serial). */
export function iso6346CheckDigit(first10: string): number {
  if (!/^[A-Z]{4}\d{6}$/.test(first10)) throw new Error('Expected 4 letters followed by 6 digits');
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const value = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10;
}

export type ContainerNumberCheck =
  | { ok: true; number: string }
  | { ok: false; number: string; reason: 'NOT_ISO6346_FORMAT' | 'BAD_CHECK_DIGIT'; expectedCheckDigit?: number };

export function checkContainerNumber(raw: string): ContainerNumberCheck {
  const number = normalizeContainerNumber(raw);
  if (!ISO6346_PATTERN.test(number)) return { ok: false, number, reason: 'NOT_ISO6346_FORMAT' };
  const expected = iso6346CheckDigit(number.slice(0, 10));
  if (expected !== Number(number[10])) {
    return { ok: false, number, reason: 'BAD_CHECK_DIGIT', expectedCheckDigit: expected };
  }
  return { ok: true, number };
}
