import { describe, expect, it } from 'vitest';
import { checkContainerNumber, iso6346CheckDigit, normalizeContainerNumber } from '../src/common/iso6346';

describe('ISO 6346 container numbers', () => {
  it('computes the check digit for known real-world numbers', () => {
    expect(iso6346CheckDigit('CSQU305438')).toBe(3); // CSQU3054383, the standard published example
    expect(iso6346CheckDigit('MSKU123456')).toBe(5);
    expect(iso6346CheckDigit('TEMU600005')).toBe(0); // remainder 0
    expect(iso6346CheckDigit('MSKU100009')).toBe(0); // remainder 10 is written as check digit 0
  });

  it('follows the letter table that skips multiples of 11', () => {
    // A=10 ... K=21, L=23 (22 skipped), U=32, V=34 (33 skipped)
    // CSQU: C=13,S=30,Q=28,U=32 ; digits 3,0,5,4,3,8
    const sum = 13 * 1 + 30 * 2 + 28 * 4 + 32 * 8 + 3 * 16 + 0 * 32 + 5 * 64 + 4 * 128 + 3 * 256 + 8 * 512;
    expect(sum).toBe(6185);
    expect(sum % 11).toBe(3);
  });

  it('accepts valid numbers and normalises typing noise', () => {
    expect(checkContainerNumber('CSQU3054383')).toEqual({ ok: true, number: 'CSQU3054383' });
    expect(checkContainerNumber('csqu 305438-3')).toEqual({ ok: true, number: 'CSQU3054383' });
    expect(normalizeContainerNumber(' ab-cu 12 ')).toBe('ABCU12');
  });

  it('rejects a wrong check digit and tells the user the right one', () => {
    const r = checkContainerNumber('CSQU3054384');
    expect(r).toEqual({ ok: false, number: 'CSQU3054384', reason: 'BAD_CHECK_DIGIT', expectedCheckDigit: 3 });
  });

  it('rejects numbers that are not in ISO 6346 format', () => {
    for (const bad of ['', 'ABC123', 'CSQX3054383', 'CSQU305438', 'CSQU30543833', '1234567890A']) {
      const r = checkContainerNumber(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toBe('NOT_ISO6346_FORMAT');
    }
  });

  it('only accepts category letters U, J and Z in the 4th position', () => {
    expect(checkContainerNumber('CSQJ3054383').ok === false && (checkContainerNumber('CSQJ3054383') as any).reason).not.toBe('NOT_ISO6346_FORMAT');
    expect((checkContainerNumber('CSQA3054383') as any).reason).toBe('NOT_ISO6346_FORMAT');
  });
});
