/**
 * Every report is built as ONE uniform table. The JSON endpoints, the Excel / CSV export and the
 * printable PDFs all render the same table, so they can never disagree.
 */
export type ColumnType = 'text' | 'money' | 'int' | 'date' | 'percent';

export interface ReportColumn {
  key: string;
  header: { en: string; ar: string };
  type: ColumnType;
}

export interface ReportTable {
  /** machine name used in URLs and file names */
  name: string;
  title: { en: string; ar: string };
  columns: ReportColumn[];
  rows: Record<string, unknown>[];
  /** values for the columns that are meaningful to total (same keys as columns) */
  totals?: Record<string, unknown>;
  /** basis, currency, period and any report-wide figures */
  meta: Record<string, unknown>;
}

export const col = (key: string, en: string, ar: string, type: ColumnType = 'text'): ReportColumn => ({ key, header: { en, ar }, type });

export const REPORT_NAMES = [
  'clearance-files', 'client-balances', 'expenses', 'revenue', 'employee-performance', 'profitability', 'financial-summary', 'trial-balance',
] as const;
export type ReportName = (typeof REPORT_NAMES)[number];
