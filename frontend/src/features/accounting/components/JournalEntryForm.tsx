import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { formatMoney, type Locale } from '@/lib/format';
import { today } from '@/features/clearance-files/components/payments/types';
import type { Currency } from '@/features/clearance-files/components/invoices/types';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import { POSITIVE, type LedgerAccount } from '../types';

interface Line { accountCode: string; debit: string; credit: string; currencyCode: string }

/** A manual adjustment: at least two lines, debits equal to credits (the API checks in base currency). */
export function JournalEntryForm({ baseCurrency, onSaved, onCancel }: { baseCurrency: string; onSaved: () => void | Promise<void>; onCancel: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const blank = (): Line => ({ accountCode: '', debit: '', credit: '', currencyCode: baseCurrency });
  const [date, setDate] = useState(today());
  const [description, setDescription] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [touched, setTouched] = useState(false);
  const accounts = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => api.get<LedgerAccount[]>('/accounting/accounts') });
  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const usable = (accounts.data ?? []).filter((a) => a.isActive);

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineError = (l: Line) => {
    if (!l.accountCode) return 'acc.accountRequired';
    const d = l.debit.trim() !== '', c = l.credit.trim() !== '';
    if (d === c) return 'acc.oneSide';
    return POSITIVE(d ? l.debit : l.credit) ? null : 'pay.amountInvalid';
  };
  const valid = description.trim().length >= 3 && lines.length >= 2 && lines.every((l) => !lineError(l));

  // A running difference helps only when every line is in one currency; otherwise the API compares base values.
  const currenciesUsed = new Set(lines.map((l) => l.currencyCode));
  const diff = currenciesUsed.size === 1 && lines.every((l) => !lineError(l))
    ? lines.reduce((s, l) => s + (l.debit.trim() ? Number(l.debit) : -Number(l.credit)), 0) : null;

  const save = useMutation({
    mutationFn: () => api.post('/accounting/journal-entries', {
      entryDate: date, description: description.trim(),
      lines: lines.map((l) => ({ accountCode: l.accountCode, currencyCode: l.currencyCode, ...(l.debit.trim() ? { debit: l.debit.trim() } : { credit: l.credit.trim() }) })),
    }),
    onSuccess: async () => { await onSaved(); },
  });

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{t('acc.newEntry')}</h2>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('pay.date')} htmlFor="je-date"><Input id="je-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <div className="sm:col-span-2">
            <Field label={t('inv.description')} htmlFor="je-desc" error={touched && description.trim().length < 3 ? t('acc.descriptionShort') : undefined}>
              <Input id="je-desc" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </div>
        <div className="space-y-2">
          {lines.map((l, i) => {
            const err = touched ? lineError(l) : null;
            return (
              <div key={i} className="rounded-md border border-slate-200 bg-white p-3">
                <div className="grid gap-3 sm:grid-cols-12">
                  <div className="sm:col-span-4">
                    <Field label={t('acc.account')} htmlFor={`je-acc-${i}`}>
                      <Select id={`je-acc-${i}`} value={l.accountCode} onChange={(e) => set(i, { accountCode: e.target.value })}>
                        <option value="" />
                        {usable.map((a) => <option key={a.id} value={a.accountCode}>{a.accountCode} · {a.name}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Field label={t('acc.debit')} htmlFor={`je-debit-${i}`}><Input id={`je-debit-${i}`} inputMode="decimal" dir="ltr" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, ...(e.target.value ? { credit: '' } : {}) })} /></Field>
                  </div>
                  <div className="sm:col-span-2">
                    <Field label={t('acc.credit')} htmlFor={`je-credit-${i}`}><Input id={`je-credit-${i}`} inputMode="decimal" dir="ltr" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, ...(e.target.value ? { debit: '' } : {}) })} /></Field>
                  </div>
                  <div className="sm:col-span-3">
                    <Field label={t('inv.currency')} htmlFor={`je-cur-${i}`}>
                      <Select id={`je-cur-${i}`} value={l.currencyCode} onChange={(e) => set(i, { currencyCode: e.target.value })}>
                        {(currencies.data ?? [{ code: baseCurrency, name: baseCurrency, decimalPlaces: 2 }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
                      </Select>
                    </Field>
                  </div>
                  <div className="flex items-end sm:col-span-1">
                    {lines.length > 2 && <Button type="button" variant="ghost" aria-label={`${t('inv.removeLine')} ${i + 1}`} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Trash2 className="size-4 text-red-700" aria-hidden /></Button>}
                  </div>
                </div>
                {err && <p role="alert" className="mt-1 text-xs text-red-700">{t(err)}</p>}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="secondary" onClick={() => setLines((ls) => [...ls, blank()])}><Plus className="size-4" aria-hidden />{t('acc.addLine')}</Button>
            {diff !== null && (Math.abs(diff) < 0.00005
              ? <span className="text-sm text-green-700">{t('acc.inBalance')}</span>
              : <span className="text-sm text-amber-700">{t('acc.difference', { amount: formatMoney(String(Math.abs(diff)), [...currenciesUsed][0], locale) })}</span>)}
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('acc.post')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}
