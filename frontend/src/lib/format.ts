import { format as fmt, isValid, parseISO } from 'date-fns';
import { enUS } from 'date-fns/locale';

export type Locale = 'en' | 'ar';
// Numbers use Western digits and the same grouping (1,234.50) in both languages: it is what Lebanese offices write, and it
// avoids the ambiguity of a locale that swaps the roles of the comma and the dot.
const intlTag = (_l: Locale) => 'en-US';
const MONTHS_AR = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];

/** Money arrives as exact decimal strings; this is display formatting only, never arithmetic. */
export function formatMoney(amount: string | number | null | undefined, currency: string | undefined, locale: Locale): string {
  if (amount === null || amount === undefined || amount === '') return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount);
  const digits = currency === 'LBP' ? 0 : 2;
  const num = new Intl.NumberFormat(intlTag(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
  return currency ? `${num} ${currency}` : num;
}

export function formatNumber(n: number | string | null | undefined, locale: Locale): string {
  if (n === null || n === undefined || n === '') return '—';
  return new Intl.NumberFormat(intlTag(locale)).format(Number(n));
}

export function formatDate(value: string | Date | null | undefined, locale: Locale, withTime = false): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? parseISO(value) : value;
  if (!isValid(d)) return '—';
  if (locale === 'ar') return `${d.getDate()} ${MONTHS_AR[d.getMonth()]} ${d.getFullYear()}${withTime ? `، ${fmt(d, 'HH:mm')}` : ''}`;
  return fmt(d, withTime ? 'd MMM yyyy, HH:mm' : 'd MMM yyyy', { locale: enUS });
}

export const fullName = (u?: { firstName?: string; lastName?: string } | null) => (u ? `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim() || '—' : '—');

/** File sizes for people: 1.4 MB, 820 KB. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
