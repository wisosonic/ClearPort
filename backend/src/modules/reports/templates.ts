import type { ReportTable } from './report-table';

export type Locale = 'en' | 'ar';

/** Every piece of dynamic text goes through this. Templates are also rendered with scripts and network disabled. */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]!));
}

const LABELS = {
  en: {
    invoice: 'Invoice', advance: 'Advance request', supplementary: 'Supplementary invoice', final: 'Final invoice', standard: 'Invoice',
    draft: 'DRAFT', cancelled: 'CANCELLED', invoiceNo: 'Invoice no.', issueDate: 'Issue date', dueDate: 'Due date', billTo: 'Bill to', taxNo: 'Tax no.',
    file: 'File', customsRef: 'Customs reference', vessel: 'Vessel', bl: 'Bill of lading', containers: 'Containers',
    description: 'Description', qty: 'Qty', unitPrice: 'Unit price', amount: 'Amount', tax: 'Tax', subtotal: 'Subtotal', discount: 'Discount', total: 'Total',
    paid: 'Paid', balanceDue: 'Balance due', payments: 'Payments applied', payment: 'Payment', date: 'Date', rate: 'Exchange rate', baseEquivalent: 'Base-currency value',
    cancelReason: 'Cancelled', advanceNote: 'This is a request for funds on account. It is not a tax invoice.', page: 'Page',
    statement: 'Statement of account', period: 'Period', balances: 'Balances', type: 'Type', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance',
    opening: 'Opening balance', closing: 'Closing balance', currency: 'Currency', basisTx: 'Amounts are in each transaction\'s own currency (not converted).',
    positive: 'Positive = the client owes the office; negative = credit held for the client.', generated: 'Generated', all: 'All', phone: 'Tel', email: 'Email',
    INVOICE: 'Invoice', PAYMENT: 'Payment', REFUND: 'Refund', ALLOCATION: 'Applied', totalRow: 'Total', client: 'Client', rows: 'rows',
  },
  ar: {
    invoice: 'فاتورة', advance: 'طلب دفعة مقدّمة', supplementary: 'فاتورة تكميلية', final: 'فاتورة نهائية', standard: 'فاتورة',
    draft: 'مسودة', cancelled: 'ملغاة', invoiceNo: 'رقم الفاتورة', issueDate: 'تاريخ الإصدار', dueDate: 'تاريخ الاستحقاق', billTo: 'فاتورة إلى', taxNo: 'الرقم الضريبي',
    file: 'الملف', customsRef: 'المرجع الجمركي', vessel: 'الباخرة', bl: 'بوليصة الشحن', containers: 'الحاويات',
    description: 'البيان', qty: 'الكمية', unitPrice: 'سعر الوحدة', amount: 'المبلغ', tax: 'الضريبة', subtotal: 'المجموع الفرعي', discount: 'الحسم', total: 'الإجمالي',
    paid: 'المدفوع', balanceDue: 'المبلغ المستحق', payments: 'الدفعات المطبّقة', payment: 'الدفعة', date: 'التاريخ', rate: 'سعر الصرف', baseEquivalent: 'القيمة بالعملة الأساسية',
    cancelReason: 'سبب الإلغاء', advanceNote: 'هذا طلب دفعة على الحساب وليس فاتورة ضريبية.', page: 'صفحة',
    statement: 'كشف حساب', period: 'الفترة', balances: 'الأرصدة', type: 'النوع', reference: 'المرجع', debit: 'مدين', credit: 'دائن', balance: 'الرصيد',
    opening: 'الرصيد الافتتاحي', closing: 'الرصيد الختامي', currency: 'العملة', basisTx: 'المبالغ بعملة كل معاملة (دون تحويل).',
    positive: 'الرصيد الموجب = مستحق على العميل؛ السالب = رصيد دائن للعميل.', generated: 'أُنشئ', all: 'الكل', phone: 'هاتف', email: 'بريد',
    INVOICE: 'فاتورة', PAYMENT: 'دفعة', REFUND: 'مردود', ALLOCATION: 'تسوية', totalRow: 'الإجمالي', client: 'العميل', rows: 'سطر',
  },
} as const;
export const label = (locale: Locale, key: keyof (typeof LABELS)['en']) => LABELS[locale][key];

const num = new Intl.NumberFormat('en-US');
/** Western digits in both languages: amounts must read identically on a bilingual paper trail. */
export function makeMoney(values: (string | null | undefined)[], decimalPlaces: number) {
  // Show the currency's natural precision, unless some value really carries more: then show all four
  // decimals everywhere, so the printed lines visibly add up to the printed total.
  const carriesMore = values.some((v) => !!v && /[1-9]/.test((v.split('.')[1] ?? '').slice(decimalPlaces)));
  const dp = carriesMore ? 4 : decimalPlaces;
  const fmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  return (v: string | null | undefined) => {
    if (v === null || v === undefined || v === '') return '';
    const n = Number(v);
    return Number.isNaN(n) ? esc(v) : fmt.format(n);
  };
}
export const fmtInt = (v: unknown) => num.format(Number(v));
export function fmtDate(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return '';
  const d = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-LB-u-nu-latn' : 'en-GB', { day: '2-digit', month: locale === 'ar' ? 'long' : 'short', year: 'numeric', timeZone: 'UTC' }).format(d);
}

const css = (rtl: boolean) => `
  @page { size: A4; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Segoe UI', Tahoma, 'Noto Sans Arabic', 'Noto Naskh Arabic', Arial, sans-serif; font-size: 11px; color: #1b2430; direction: ${rtl ? 'rtl' : 'ltr'}; }
  h1 { font-size: 22px; margin: 0; color: #1f3a5f; } h2 { font-size: 13px; margin: 14px 0 6px; color: #1f3a5f; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1f3a5f; padding-bottom: 10px; }
  .office { font-size: 10.5px; line-height: 1.5; color: #444; } .office b { font-size: 14px; color: #1b2430; }
  .meta { text-align: ${rtl ? 'left' : 'right'}; line-height: 1.6; } .meta .no { font-size: 15px; font-weight: 700; }
  .cols { display: flex; gap: 24px; margin-top: 12px; } .cols > div { flex: 1; line-height: 1.55; }
  .box { border: 1px solid #d6dce5; border-radius: 4px; padding: 8px 10px; background: #f8fafc; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; } thead { display: table-header-group; }
  th { background: #1f3a5f; color: #fff; font-weight: 600; padding: 6px 7px; text-align: ${rtl ? 'right' : 'left'}; font-size: 10.5px; }
  td { padding: 5px 7px; border-bottom: 1px solid #e3e8ef; vertical-align: top; } tr { page-break-inside: avoid; }
  .n { text-align: ${rtl ? 'left' : 'right'}; font-variant-numeric: tabular-nums; direction: ltr; white-space: nowrap; }
  th.n { direction: ${rtl ? 'rtl' : 'ltr'}; }
  .totals { width: 46%; margin-${rtl ? 'right' : 'left'}: auto; margin-top: 10px; } .totals td { border: 0; padding: 3px 7px; } .totals .grand td { border-top: 2px solid #1f3a5f; font-weight: 700; font-size: 13px; }
  .stamp { position: fixed; top: 38%; ${rtl ? 'right' : 'left'}: 22%; transform: rotate(-28deg); font-size: 84px; font-weight: 800; color: rgba(190,30,45,.14); letter-spacing: 6px; border: 8px solid rgba(190,30,45,.14); padding: 4px 28px; }
  .note { margin-top: 10px; padding: 7px 10px; background: #fff7e6; border: 1px solid #f0d9a8; border-radius: 4px; }
  .muted { color: #6b7685; font-size: 10px; } .tot td { font-weight: 700; background: #eef2f7; }
`;

const wrap = (locale: Locale, body: string, title: string) =>
  `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css(locale === 'ar')}</style></head><body>${body}</body></html>`;

// ═══════════════════════════ invoice ═══════════════════════════

export interface InvoicePrint {
  office: { name: string; legalName?: string | null; email?: string | null; phone?: string | null; address?: string | null };
  taxName: string;
  invoice: {
    invoiceNumber: string; invoiceType: string; status: string; issueDate: Date | null; dueDate: Date | null; currencyCode: string; currencyDecimals: number;
    subtotal: string; discount: string; taxAmount: string; totalAmount: string; paidAmount: string; outstandingAmount: string;
    exchangeRate: string | null; rateConvention: string | null; baseTotalAmount: string | null; baseCurrency: string; cancelReason: string | null;
  };
  client: { name: string; clientCode: string; taxNumber?: string | null; address?: string | null; phone?: string | null; email?: string | null };
  file: { fileNumber: string; customsReference?: string | null; vessel?: string | null; billOfLading?: string | null; containers: string[] };
  items: { description: string; quantity: string; unitPrice: string; amount: string; taxRate: string; taxAmount: string }[];
  payments: { paymentNumber: string; date: Date; amount: string }[];
}

export function invoiceHtml(d: InvoicePrint, locale: Locale): string {
  const t = (k: keyof (typeof LABELS)['en']) => esc(label(locale, k));
  const inv = d.invoice;
  const money = makeMoney([inv.subtotal, inv.discount, inv.taxAmount, inv.totalAmount, inv.paidAmount, inv.outstandingAmount, ...d.items.flatMap((i) => [i.unitPrice, i.amount, i.taxAmount]), ...d.payments.map((p) => p.amount)], inv.currencyDecimals);
  const kind = { ADVANCE: 'advance', SUPPLEMENTARY: 'supplementary', FINAL: 'final', STANDARD: 'standard' }[inv.invoiceType] as 'advance';
  const hasTax = d.items.some((i) => Number(i.taxAmount) > 0);
  const stamp = inv.status === 'DRAFT' ? t('draft') : inv.status === 'CANCELLED' ? t('cancelled') : '';
  const isAdvance = inv.invoiceType === 'ADVANCE';
  const line = (k: string, v: unknown) => (v ? `<div><span class="muted">${k}:</span> ${esc(v)}</div>` : '');

  const rows = d.items.map((i) => `<tr><td>${esc(i.description)}</td><td class="n">${fmtQty(i.quantity)}</td><td class="n">${money(i.unitPrice)}</td>${hasTax ? `<td class="n">${Number(i.taxRate) > 0 ? `${fmtInt(Number(i.taxRate))}%` : ''}</td>` : ''}<td class="n">${money(i.amount)}</td></tr>`).join('');
  const body = `
    ${stamp ? `<div class="stamp">${stamp}</div>` : ''}
    <div class="head">
      <div class="office"><b>${esc(d.office.name)}</b><br>${esc(d.office.legalName ?? '')}${d.office.legalName ? '<br>' : ''}${esc(d.office.address ?? '')}<br>
        ${d.office.phone ? `${t('phone')}: ${esc(d.office.phone)} ` : ''}${d.office.email ? `&nbsp; ${t('email')}: ${esc(d.office.email)}` : ''}</div>
      <div class="meta"><h1>${t(kind)}</h1><div class="muted">${t('invoiceNo')}</div><div class="no">${esc(inv.invoiceNumber)}</div>
        <div><span class="muted">${t('issueDate')}:</span> ${esc(fmtDate(inv.issueDate, locale))}</div>
        ${isAdvance ? '' : `<div><span class="muted">${t('dueDate')}:</span> ${esc(fmtDate(inv.dueDate, locale))}</div>`}</div>
    </div>
    <div class="cols">
      <div class="box"><h2 style="margin-top:0">${t('billTo')}</h2><b>${esc(d.client.name)}</b> (${esc(d.client.clientCode)})<br>
        ${esc(d.client.address ?? '')}${d.client.address ? '<br>' : ''}${d.client.taxNumber ? `${t('taxNo')}: ${esc(d.client.taxNumber)}<br>` : ''}${esc(d.client.phone ?? '')}</div>
      <div class="box"><h2 style="margin-top:0">${t('file')}</h2><b>${esc(d.file.fileNumber)}</b>
        ${line(String(t('customsRef')), d.file.customsReference)}${line(String(t('vessel')), d.file.vessel)}${line(String(t('bl')), d.file.billOfLading)}${line(String(t('containers')), d.file.containers.join(', '))}</div>
    </div>
    <table><thead><tr><th>${t('description')}</th><th class="n">${t('qty')}</th><th class="n">${t('unitPrice')}</th>${hasTax ? `<th class="n">${esc(d.taxName)}</th>` : ''}<th class="n">${t('amount')} (${esc(inv.currencyCode)})</th></tr></thead><tbody>${rows}</tbody></table>
    <table class="totals"><tbody>
      <tr><td>${t('subtotal')}</td><td class="n">${money(inv.subtotal)}</td></tr>
      ${Number(inv.discount) > 0 ? `<tr><td>${t('discount')}</td><td class="n">-${money(inv.discount)}</td></tr>` : ''}
      ${Number(inv.taxAmount) > 0 ? `<tr><td>${esc(d.taxName)}</td><td class="n">${money(inv.taxAmount)}</td></tr>` : ''}
      <tr class="grand"><td>${t('total')} (${esc(inv.currencyCode)})</td><td class="n">${money(inv.totalAmount)}</td></tr>
      ${!isAdvance && inv.status === 'ISSUED' ? `<tr><td>${t('paid')}</td><td class="n">${money(inv.paidAmount)}</td></tr><tr><td><b>${t('balanceDue')}</b></td><td class="n"><b>${money(inv.outstandingAmount)}</b></td></tr>` : ''}
    </tbody></table>
    ${isAdvance ? `<div class="note">${t('advanceNote')}</div>` : ''}
    ${inv.status === 'CANCELLED' && inv.cancelReason ? `<div class="note">${t('cancelReason')}: ${esc(inv.cancelReason)}</div>` : ''}
    ${d.payments.length ? `<h2>${t('payments')}</h2><table><thead><tr><th>${t('payment')}</th><th>${t('date')}</th><th class="n">${t('amount')} (${esc(inv.currencyCode)})</th></tr></thead><tbody>
      ${d.payments.map((p) => `<tr><td>${esc(p.paymentNumber)}</td><td>${esc(fmtDate(p.date, locale))}</td><td class="n">${money(p.amount)}</td></tr>`).join('')}</tbody></table>` : ''}
    ${inv.exchangeRate && inv.currencyCode !== inv.baseCurrency ? `<p class="muted">${t('rate')}: ${esc(inv.rateConvention === 'FOREIGN_PER_BASE' ? `1 ${inv.baseCurrency} = ${trimRate(inv.exchangeRate)} ${inv.currencyCode}` : `1 ${inv.currencyCode} = ${trimRate(inv.exchangeRate)} ${inv.baseCurrency}`)} &nbsp;·&nbsp; ${t('baseEquivalent')}: ${esc(inv.baseTotalAmount ?? '')} ${esc(inv.baseCurrency)}</p>` : ''}`;
  return wrap(locale, body, `${label(locale, kind)} ${inv.invoiceNumber}`);
}

const trimRate = (r: string) => r.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
const fmtQty = (q: string) => trimRate(q);

// ═══════════════════════════ client statement ═══════════════════════════

export interface StatementPrint {
  office: { name: string };
  client: { name: string; clientCode: string; address?: string | null; taxNumber?: string | null };
  from: string | null; to: string | null;
  openingBalances: Record<string, string>; closingBalances: Record<string, string>;
  lines: { date: string; type: string; reference: string; description: string; currency: string; debit: string; credit: string; balance: string }[];
  decimals: Record<string, number>;
}

export function statementHtml(d: StatementPrint, locale: Locale): string {
  const t = (k: keyof (typeof LABELS)['en']) => esc(label(locale, k));
  const currencies = [...new Set([...Object.keys(d.closingBalances), ...d.lines.map((l) => l.currency)])].sort();
  const moneyFor = (cur: string) => makeMoney(d.lines.filter((l) => l.currency === cur).flatMap((l) => [l.debit, l.credit, l.balance]), d.decimals[cur] ?? 2);
  const sections = currencies.map((cur) => {
    const m = moneyFor(cur);
    const mine = d.lines.filter((l) => l.currency === cur);
    return `<h2>${t('currency')}: ${esc(cur)}</h2><table><thead><tr><th>${t('date')}</th><th>${t('type')}</th><th>${t('reference')}</th><th class="n">${t('debit')}</th><th class="n">${t('credit')}</th><th class="n">${t('balance')}</th></tr></thead><tbody>
      ${d.openingBalances[cur] !== undefined ? `<tr class="tot"><td colspan="5">${t('opening')}</td><td class="n">${m(d.openingBalances[cur])}</td></tr>` : ''}
      ${mine.map((l) => `<tr><td>${esc(fmtDate(l.date, locale))}</td><td>${esc((LABELS[locale] as Record<string, string>)[l.type] ?? l.type)}</td><td>${esc(l.reference)}</td><td class="n">${Number(l.debit) ? m(l.debit) : ''}</td><td class="n">${Number(l.credit) ? m(l.credit) : ''}</td><td class="n">${m(l.balance)}</td></tr>`).join('')}
      <tr class="tot"><td colspan="5">${t('closing')}</td><td class="n">${m(d.closingBalances[cur] ?? '0')}</td></tr></tbody></table>`;
  }).join('');
  const body = `<div class="head"><div class="office"><b>${esc(d.office.name)}</b></div><div class="meta"><h1>${t('statement')}</h1>
      <div><b>${esc(d.client.name)}</b> (${esc(d.client.clientCode)})</div><div><span class="muted">${t('period')}:</span> ${esc(d.from ?? '…')} → ${esc(d.to ?? '…')}</div></div></div>
    ${sections || `<p class="muted">—</p>`}
    <p class="muted">${t('basisTx')}<br>${t('positive')}</p>`;
  return wrap(locale, body, `${label(locale, 'statement')} ${d.client.clientCode}`);
}

// ═══════════════════════════ any report table ═══════════════════════════

export function tableHtml(t: ReportTable, o: { locale: Locale; officeName: string; subtitle: string }): string {
  const locale = o.locale;
  const lbl = (k: keyof (typeof LABELS)['en']) => esc(label(locale, k));
  const money = (v: unknown) => (v === null || v === undefined || v === '' ? '' : Number.isNaN(Number(v)) ? esc(v) : new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v)));
  const cell = (c: import('./report-table').ReportColumn, v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    switch (c.type) {
      case 'money': return money(v);
      case 'int': return fmtInt(v);
      case 'percent': return `${esc(v)}%`;
      case 'date': return esc(fmtDate(String(v), locale));
      default: return esc(v);
    }
  };
  const isNum = (c: { type: string }) => c.type !== 'text' && c.type !== 'date';
  const head = t.columns.map((c) => `<th class="${isNum(c) ? 'n' : ''}">${esc(c.header[locale])}</th>`).join('');
  const rows = t.rows.map((r) => `<tr>${t.columns.map((c) => `<td class="${isNum(c) ? 'n' : ''}">${cell(c, c.key === 'stage' && locale === 'ar' ? (r as any).stageAr ?? r[c.key] : r[c.key])}</td>`).join('')}</tr>`).join('');
  const totals = t.totals ? `<tr class="tot">${t.columns.map((c, i) => `<td class="${isNum(c) ? 'n' : ''}">${i === 0 && t.totals![c.key] === undefined ? lbl('totalRow') : cell(c, t.totals![c.key])}</td>`).join('')}</tr>` : '';
  const tbc = (t.meta as any).totalsByCurrency as Record<string, Record<string, string>> | undefined;
  const perCur = tbc ? `<h2>${lbl('totalRow')} / ${lbl('currency')}</h2><table><tbody>${Object.entries(tbc).flatMap(([metric, byCur]) => Object.entries(byCur).map(([cur, v]) => `<tr><td>${esc(metric)} (${esc(cur)})</td><td class="n">${money(v)}</td></tr>`)).join('')}</tbody></table>` : '';
  const body = `<div class="head"><div class="office"><b>${esc(o.officeName)}</b></div><div class="meta"><h1 style="font-size:18px">${esc(t.title[locale])}</h1><div class="muted">${esc(o.subtitle)}</div></div></div>
    <table><thead><tr>${head}</tr></thead><tbody>${rows}${totals}</tbody></table>${perCur}
    <p class="muted">${t.rows.length} ${lbl('rows')} · ${lbl('generated')} ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</p>`;
  return wrap(locale, body, t.title[locale]);
}
