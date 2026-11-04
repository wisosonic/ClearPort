import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import type { Currency } from '../invoices/types';
import { METHODS, POSITIVE, RECORDABLE, today, type CashAccount, type PaymentType } from './types';

/** Record money received from the file's client, or a refund of credit they hold. */
export function PaymentForm({ fileId, clientId, baseCurrency, onSaved, onCancel }: {
  fileId: string; clientId: string; baseCurrency: string; onSaved: () => void | Promise<void>; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState<PaymentType>('CLIENT_PAYMENT');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState(baseCurrency);
  const [cashId, setCashId] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [date, setDate] = useState(today());
  const [touched, setTouched] = useState(false);

  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const accounts = useQuery({ queryKey: ['cash-accounts'], queryFn: () => api.get<CashAccount[]>('/cash-accounts') });
  const matching = (accounts.data ?? []).filter((a) => a.isActive && a.currencyCode === currency);
  const chosen = matching.some((a) => a.id === cashId) ? cashId : matching.length === 1 ? matching[0].id : '';

  const save = useMutation({
    mutationFn: () => api.post('/payments', {
      clientId, clearanceFileId: fileId, paymentType: type, amount: amount.trim(), currencyCode: currency, cashAccountId: chosen,
      paymentMethod: method, referenceNumber: reference.trim() || undefined, paymentDate: date || undefined,
    }),
    onSuccess: async () => { await onSaved(); },
  });
  const errors = {
    amount: !POSITIVE(amount) ? t('pay.amountInvalid') : undefined,
    cash: !chosen ? t('pay.cashRequired') : undefined,
  };
  const valid = !errors.amount && !errors.cash;

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{t('pay.record')}</h2>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('pay.type')} htmlFor="pay-type" hint={t(`pay.typeHint.${type}`)}>
            <Select id="pay-type" value={type} onChange={(e) => setType(e.target.value as PaymentType)}>
              {RECORDABLE.map((x) => <option key={x} value={x}>{t(`pay.types.${x}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('pay.amount')} htmlFor="pay-amount" error={touched ? errors.amount : undefined}>
            <Input id="pay-amount" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t('inv.currency')} htmlFor="pay-currency">
            <Select id="pay-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.data ?? [{ code: baseCurrency, name: baseCurrency, decimalPlaces: 2 }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </Select>
          </Field>
          <Field label={t('pay.cashAccount')} htmlFor="pay-cash" error={touched ? errors.cash : undefined} hint={matching.length === 0 && accounts.data ? t('pay.noAccount', { currency }) : undefined}>
            <Select id="pay-cash" value={chosen} onChange={(e) => setCashId(e.target.value)}>
              <option value="" />
              {matching.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label={t('pay.method')} htmlFor="pay-method">
            <Select id="pay-method" value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => <option key={m} value={m}>{t(`pay.methods.${m}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('pay.date')} htmlFor="pay-date"><Input id="pay-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <Field label={t('pay.reference')} htmlFor="pay-ref"><Input id="pay-ref" dir="auto" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('pay.save')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}
