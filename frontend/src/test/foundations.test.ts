import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import arCommon from '@/i18n/ar/common.json';
import enCommon from '@/i18n/en/common.json';
import { NAV } from '@/app/nav';
import { formatDate, formatMoney, formatNumber } from '@/lib/format';
import { can, canAny } from '@/lib/permissions';

const keys = (o: Record<string, any>, p = ''): string[] => Object.entries(o).flatMap(([k, v]) => (typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`]));
const base = (k: string) => k.replace(/_(zero|one|two|few|many|other)$/, '');

const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? (n === 'test' ? [] : files(p)) : /\.(tsx?|css)$/.test(n) ? [p] : [];
});
const SRC = join(__dirname, '..');

describe('translations', () => {
  it('have the same keys in English and Arabic', () => {
    const en = new Set(keys(enCommon).map(base));
    const ar = new Set(keys(arCommon).map(base));
    expect([...en].filter((k) => !ar.has(k))).toEqual([]);
    expect([...ar].filter((k) => !en.has(k))).toEqual([]);
  });

  it('have no empty strings', () => {
    for (const [name, dict] of [['en', enCommon], ['ar', arCommon]] as const) {
      expect(keys(dict).filter((k) => !(dict as any as Record<string, unknown>)[k] && String(k).length === 0), name).toEqual([]);
    }
    const flat = (o: any): string[] => Object.values(o).flatMap((v) => (typeof v === 'object' ? flat(v) : [String(v)]));
    expect(flat(enCommon).filter((s) => s.trim() === '')).toEqual([]);
    expect(flat(arCommon).filter((s) => s.trim() === '')).toEqual([]);
  });

  it('cover every navigation label', () => {
    const en = new Set(keys(enCommon));
    for (const g of NAV) {
      if (g.titleKey) expect(en.has(g.titleKey), g.titleKey).toBe(true);
      for (const i of g.items) expect(en.has(i.labelKey), i.labelKey).toBe(true);
    }
  });
});

describe('right-to-left safety', () => {
  // Physical left/right utilities do not flip in Arabic. Use the logical ones: ms-/me-/ps-/pe-/start-/end-/text-start/text-end/border-s/e/rounded-s/e.
  const PHYSICAL = /(?:^|[\s"'`:])(-?(?:ml|mr|pl|pr)-[\w[.\]/]+|(?:left|right)-[\w[.\]/]+|text-(?:left|right)|float-(?:left|right)|border-[lr](?:-[\w]+)?|rounded-[lr](?:-[\w]+)?|rounded-(?:tl|tr|bl|br)(?:-[\w]+)?|space-x-reverse)(?=[\s"'`]|$)/g;

  it('uses logical spacing and alignment classes only', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(PHYSICAL)) offenders.push(`${f.replace(SRC, 'src')}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('formatting', () => {
  it('formats money from exact decimal strings in both languages, with Latin digits', () => {
    expect(formatMoney('1234567.5', 'USD', 'en')).toBe('1,234,567.50 USD');
    expect(formatMoney('89500000', 'LBP', 'en')).toBe('89,500,000 LBP');
    expect(formatMoney('1234.5', 'USD', 'ar')).toBe('1,234.50 USD'); // same grouping in Arabic
    expect(formatMoney(null, 'USD', 'en')).toBe('—');
    expect(formatMoney('', 'USD', 'ar')).toBe('—');
    expect(formatNumber(1234, 'en')).toBe('1,234');
  });

  it('formats dates in the chosen language and survives bad input', () => {
    expect(formatDate('2026-11-03T10:30:00.000+00:00', 'en')).toMatch(/^3 Nov 2026$/);
    expect(formatDate('2026-11-03T10:30:00.000+00:00', 'ar')).toContain('تشرين الثاني');
    expect(formatDate('nonsense', 'en')).toBe('—');
    expect(formatDate(null, 'ar')).toBe('—');
  });
});

describe('permission helpers', () => {
  it('can() needs all, canAny() needs one', () => {
    const g = new Set(['clients.view', 'tasks.view']);
    expect(can(g, 'clients.view')).toBe(true);
    expect(can(g, 'clients.view', 'clients.manage')).toBe(false);
    expect(canAny(g, 'clients.manage', 'tasks.view')).toBe(true);
    expect(canAny(g)).toBe(false);
    expect(can(['a'], 'a')).toBe(true);
  });
});
