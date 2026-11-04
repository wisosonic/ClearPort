import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatMoney, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { AMOUNT, INVOICE_TYPES, isoDay, POSITIVE, type BillableExpense, type Category, type Currency, type Invoice, type InvoiceType, type LineDraft } from './types';

const toDraft = (inv: Invoice): LineDraft[] => (inv.items ?? []).map((i) => (i.expenseId
  ? { kind: 'expense', expenseId: i.expenseId, description: i.description, amount: i.amount }
  : { kind: 'service', description: i.description, categoryId: i.categoryId ?? '', quantity: i.quantity.replace(/\.?0+$/, '') || '1', unitPrice: i.unitPrice }));

/** Create a draft invoice for a file, or edit one (`invoice`, which must include its items). */
export function InvoiceForm({ fileId, invoice, baseCurrency, onSaved, onCancel }: {
  fileId: string; invoice?: Invoice; baseCurrency: string; onSaved: () => void | Promise<void>; onCancel: () => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const [type, setType] = useState<InvoiceType>(invoice?.invoiceType ?? 'STANDARD');
  const [currency, setCurrency] = useState(invoice?.currencyCode ?? baseCurrency);
  const [dueDate, setDueDate] = useState(isoDay(invoice?.dueDate));
  const [discount, setDiscount] = useState(invoice ? invoice.discount.replace(/\.?0+$/, '') || '0' : '0');
  const [lines, setLines] = useState<LineDraft[]>(invoice ? toDraft(invoice) : [{ kind: 'service', description: '', categoryId: '', quantity: '1', unitPrice: '' }]);
  const [touched, setTouched] = useState(false);

  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const categories = useQuery({ queryKey: ['financial-categories'], queryFn: () => api.get<Category[]>('/financial-categories') });
  const canExpenses = can(permissions, 'expenses.view');
  const expenses = useQuery({
    queryKey: ['file-expenses-billable', fileId],
    queryFn: () => api.list<BillableExpense>('/expenses', { clearanceFileId: fileId, status: 'APPROVED', billed: 'false', limit: 100 }),
    enabled: canExpenses,
  });

  const advance = type === 'ADVANCE';
  const feeCategories = (categories.data ?? []).filter((c) => c.isActive && c.costTreatment === 'OFFICE_REVENUE' && c.isBillableToClient);
  const used = new Set(lines.flatMap((l) => (l.kind === 'expense' ? [l.expenseId] : [])));
  const billableCategory = new Set((categories.data ?? []).filter((c) => c.costTreatment === 'PASS_THROUGH' && c.isBillableToClient).map((c) => c.id));
  const rebillable = (expenses.data?.data ?? []).filter((e) => e.currencyCode === currency && !used.has(e.id) && !!e.category && billableCategory.has(e.category.id));

  const setLine = (i: number, patch: Partial<Extract<LineDraft, { kind: 'service' }>>) =>
    setLines((ls) => ls.map((l, j) => (j === i && l.kind === 'service' ? { ...l, ...patch } : l)));

  const lineError = (l: LineDraft) => {
    if (l.kind === 'expense') return null;
    if (!l.description.trim()) return 'inv.descriptionRequired';
    if (!advance && !l.categoryId) return 'inv.categoryRequired';
    if (!POSITIVE(l.quantity)) return 'inv.quantityInvalid';
    if (!AMOUNT.test(l.unitPrice.trim())) return 'inv.priceInvalid';
    return null;
  };
  const discountOk = AMOUNT.test(discount.trim());
  const valid = lines.length > 0 && lines.every((l) => !lineError(l)) && discountOk;

  const save = useMutation({
    mutationFn: () => {
      const items = lines.map((l) => (l.kind === 'expense'
        ? { expenseId: l.expenseId }
        : { description: l.description.trim(), categoryId: l.categoryId || undefined, quantity: l.quantity.trim(), unitPrice: l.unitPrice.trim() }));
      const common = { invoiceType: type, currencyCode: currency, discount: discount.trim(), items };
      return invoice
        ? api.patch(`/invoices/${invoice.id}`, { ...common, dueDate: dueDate ? dueDate : null })
        : api.post('/invoices', { ...common, clearanceFileId: fileId, ...(dueDate ? { dueDate } : {}) });
    },
    onSuccess: async () => { await onSaved(); },
  });

  const changeType = (next: InvoiceType) => {
    setType(next);
    if (next === 'ADVANCE') { setLines((ls) => ls.filter((l) => l.kind === 'service')); setDiscount('0'); }
  };

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{invoice ? t('inv.editDraft') : t('inv.newDraft')}</h2>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-4">
          <Field label={t('inv.type')} htmlFor="inv-type">
            <Select id="inv-type" value={type} onChange={(e) => changeType(e.target.value as InvoiceType)}>
              {INVOICE_TYPES.map((x) => <option key={x} value={x}>{t(`inv.types.${x}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('inv.currency')} htmlFor="inv-currency">
            <Select id="inv-currency" value={currency}
              onChange={(e) => { setCurrency(e.target.value); setLines((ls) => ls.filter((l) => l.kind === 'service')); }}>
              {(currencies.data ?? [{ code: baseCurrency, name: baseCurrency, decimalPlaces: 2 }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </Select>
          </Field>
          <Field label={t('inv.dueDate')} htmlFor="inv-due"><Input id="inv-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label={t('inv.discount')} htmlFor="inv-discount" error={touched && !discountOk ? t('inv.priceInvalid') : undefined} hint={advance ? t('inv.noDiscountAdvance') : undefined}>
            <Input id="inv-discount" inputMode="decimal" dir="ltr" value={discount} disabled={advance} onChange={(e) => setDiscount(e.target.value)} />
          </Field>
        </div>

        <div className="space-y-3">
          <h3 className="text-sm font-medium text-slate-700">{t('inv.lines')}</h3>
          {lines.map((l, i) => {
            const err = touched ? lineError(l) : null;
            return l.kind === 'expense' ? (
              <div key={`e-${l.expenseId}`} className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm">
                <span dir="auto" className="min-w-0 flex-1 break-words">{l.description} <span className="text-xs text-slate-500">({t('inv.atCost')})</span></span>
                <span dir="ltr" className="tabular-nums">{formatMoney(l.amount, currency, locale)}</span>
                <Button type="button" variant="ghost" aria-label={`${t('inv.removeLine')} ${l.description}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4 text-red-700" aria-hidden /></Button>
              </div>
            ) : (
              <div key={`s-${i}`} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="grid gap-3 sm:grid-cols-12">
                  <div className="sm:col-span-4">
                    <Field label={t('inv.description')} htmlFor={`line-desc-${i}`}><Input id={`line-desc-${i}`} dir="auto" value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></Field>
                  </div>
                  {!advance && (
                    <div className="sm:col-span-3">
                      <Field label={t('inv.category')} htmlFor={`line-cat-${i}`}>
                        <Select id={`line-cat-${i}`} value={l.categoryId} onChange={(e) => setLine(i, { categoryId: e.target.value })}>
                          <option value="" />
                          {feeCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                      </Field>
                    </div>
                  )}
                  <div className="sm:col-span-2"><Field label={t('inv.quantity')} htmlFor={`line-qty-${i}`}><Input id={`line-qty-${i}`} inputMode="decimal" dir="ltr" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} /></Field></div>
                  <div className="sm:col-span-2"><Field label={t('inv.unitPrice')} htmlFor={`line-price-${i}`}><Input id={`line-price-${i}`} inputMode="decimal" dir="ltr" value={l.unitPrice} onChange={(e) => setLine(i, { unitPrice: e.target.value })} /></Field></div>
                  <div className="flex items-end sm:col-span-1">
                    {lines.length > 1 && <Button type="button" variant="ghost" aria-label={`${t('inv.removeLine')} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4 text-red-700" aria-hidden /></Button>}
                  </div>
                </div>
                {err && <p role="alert" className="mt-1 text-xs text-red-700">{t(err)}</p>}
              </div>
            );
          })}
          {touched && lines.length === 0 && <p role="alert" className="text-xs text-red-700">{t('inv.linesRequired')}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, { kind: 'service', description: '', categoryId: '', quantity: '1', unitPrice: '' }])}>
              <Plus className="size-4" aria-hidden />{t('inv.addService')}
            </Button>
            {!advance && canExpenses && rebillable.length > 0 && (
              <Select aria-label={t('inv.addExpense')} value="" onChange={(e) => {
                const x = rebillable.find((r) => r.id === e.target.value);
                if (x) setLines((ls) => [...ls, { kind: 'expense', expenseId: x.id, description: x.description, amount: x.amount }]);
              }} className="w-auto">
                <option value="">{t('inv.addExpense')}</option>
                {rebillable.map((x) => <option key={x.id} value={x.id}>{x.description} — {formatMoney(x.amount, x.currencyCode, locale)}</option>)}
              </Select>
            )}
          </div>
          <p className="text-xs text-slate-500">{t('inv.totalsNote')}</p>
        </div>

        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{invoice ? t('common.save') : t('inv.createDraft')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}
