import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import type { ReportColumn, ReportTable } from './report-table';

export type Locale = 'en' | 'ar';

const MONEY_FORMAT = '#,##0.0000;[Red]-#,##0.0000';
const HEADER_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F3A5F' } };

/** Excel / CSV cells keep NUMBERS as numbers (so they sum and sort in a spreadsheet), and dates as dates. */
function cellValue(col: ReportColumn, v: unknown): ExcelJS.CellValue {
  if (v === null || v === undefined || v === '') return null;
  switch (col.type) {
    case 'money': case 'int': case 'percent': {
      const n = Number(v);
      if (Number.isNaN(n)) return String(v);
      return col.type === 'percent' ? n / 100 : n;
    }
    case 'date': return typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : (v as Date);
    default: return String(v);
  }
}

/** Text that starts with = + - @ would be run as a formula by Excel: neutralise it (CSV/formula injection). */
export function safeText(value: unknown): string {
  const s = String(value ?? '');
  return /^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s)) ? `'${s}` : s;
}

@Injectable()
export class ExportService {
  localName(t: ReportTable, locale: Locale) {
    return t.title[locale];
  }

  fileName(t: ReportTable, ext: string, at = new Date()) {
    return `${t.name}-${at.toISOString().slice(0, 10).replace(/-/g, '')}.${ext}`;
  }

  /** Describes the table's scope in one line: basis, period, currency. Always present, so a printout is never ambiguous. */
  subtitle(t: ReportTable, locale: Locale): string {
    const m = t.meta as Record<string, any>;
    const basis = { BASE_CURRENCY: ['Amounts in base currency', 'المبالغ بالعملة الأساسية'], TRANSACTION_CURRENCY: ['Amounts in transaction currencies (not converted)', 'المبالغ بعملات المعاملات (دون تحويل)'], COUNTS: ['Counts', 'أعداد'] }[m.basis as string];
    const parts: string[] = [];
    if (basis) parts.push(`${basis[locale === 'ar' ? 1 : 0]}${m.baseCurrency ? ` — ${m.baseCurrency}` : ''}`);
    const from = m.from as string | null; const to = (m.to ?? m.asOf) as string | null;
    if (from || to) parts.push(locale === 'ar' ? `الفترة: ${from ?? '…'} → ${to ?? '…'}` : `Period: ${from ?? '…'} → ${to ?? '…'}`);
    return parts.join('  |  ');
  }

  async toXlsx(t: ReportTable, o: { locale: Locale; officeName: string; generatedBy?: string }): Promise<Buffer> {
    const rtl = o.locale === 'ar';
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ClearPort';
    wb.created = new Date();
    const ws = wb.addWorksheet(t.title[o.locale].slice(0, 31), { views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 4 }] });

    const last = t.columns.length;
    ws.mergeCells(1, 1, 1, last);
    ws.getCell(1, 1).value = `${o.officeName} — ${t.title[o.locale]}`;
    ws.getCell(1, 1).font = { bold: true, size: 14 };
    ws.mergeCells(2, 1, 2, last);
    ws.getCell(2, 1).value = this.subtitle(t, o.locale);
    ws.getCell(2, 1).font = { italic: true, color: { argb: 'FF555555' } };
    ws.mergeCells(3, 1, 3, last);
    ws.getCell(3, 1).value = `${rtl ? 'أُنشئ' : 'Generated'}: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC${o.generatedBy ? ` — ${o.generatedBy}` : ''}`;
    ws.getCell(3, 1).font = { size: 9, color: { argb: 'FF888888' } };

    const header = ws.getRow(4);
    t.columns.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header[o.locale];
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = HEADER_FILL;
      cell.alignment = { vertical: 'middle', horizontal: c.type === 'text' ? (rtl ? 'right' : 'left') : (rtl ? 'left' : 'right'), wrapText: true };
    });
    header.height = 22;

    const format = (c: ReportColumn) => (c.type === 'money' ? MONEY_FORMAT : c.type === 'percent' ? '0.00%' : c.type === 'date' ? 'yyyy-mm-dd' : c.type === 'int' ? '#,##0' : undefined);
    for (const row of t.rows) {
      const r = ws.addRow(t.columns.map((c) => {
        const v = cellValue(c, (c.key === 'stage' && o.locale === 'ar' ? (row as any).stageAr ?? row[c.key] : row[c.key]));
        return typeof v === 'string' ? safeText(v) : v;
      }));
      t.columns.forEach((c, i) => { const f = format(c); if (f) r.getCell(i + 1).numFmt = f; });
    }
    if (t.totals) {
      const r = ws.addRow(t.columns.map((c, i) => (i === 0 && t.totals![c.key] === undefined ? (rtl ? 'الإجمالي' : 'Total') : cellValue(c, t.totals![c.key]))));
      r.font = { bold: true };
      r.border = { top: { style: 'thin' } };
      t.columns.forEach((c, i) => { const f = format(c); if (f) r.getCell(i + 1).numFmt = f; });
    }
    // per-currency totals (client balances): written as a small block so mixed currencies are never added together
    const tbc = (t.meta as any).totalsByCurrency as Record<string, Record<string, string>> | undefined;
    if (tbc) {
      ws.addRow([]);
      ws.addRow([rtl ? 'الإجمالي حسب العملة' : 'Totals by currency']).font = { bold: true };
      for (const [metric, byCur] of Object.entries(tbc)) {
        for (const [cur, v] of Object.entries(byCur)) {
          const r = ws.addRow([`${metric} (${cur})`, Number(v)]);
          r.getCell(2).numFmt = MONEY_FORMAT;
        }
      }
    }

    t.columns.forEach((c, i) => {
      const lens = [c.header[o.locale].length, ...t.rows.slice(0, 200).map((r) => String(r[c.key] ?? '').length)];
      ws.getColumn(i + 1).width = Math.min(48, Math.max(10, Math.max(...lens) + 2));
    });
    ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: last } };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** UTF-8 with a BOM so Excel opens Arabic correctly; RFC 4180 quoting; formula-injection neutralised. */
  toCsv(t: ReportTable, o: { locale: Locale }): Buffer {
    const q = (v: unknown) => `"${safeText(v).replace(/"/g, '""')}"`;
    const lines = [t.columns.map((c) => q(c.header[o.locale])).join(',')];
    for (const row of t.rows) {
      lines.push(t.columns.map((c) => {
        const raw = c.key === 'stage' && o.locale === 'ar' ? (row as any).stageAr ?? row[c.key] : row[c.key];
        return raw === null || raw === undefined ? '' : c.type === 'text' || c.type === 'date' ? q(raw) : String(raw);
      }).join(','));
    }
    if (t.totals) lines.push(t.columns.map((c, i) => (i === 0 && t.totals![c.key] === undefined ? q(o.locale === 'ar' ? 'الإجمالي' : 'Total') : t.totals![c.key] === undefined ? '' : String(t.totals![c.key]))).join(','));
    return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
  }
}
