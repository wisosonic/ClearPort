import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { PartyPicker } from '@/features/parties/PartyPicker';
import { Alert, Button, Card, Field, Input, Select } from '@/components/ui/primitives';
import type { Category, Currency } from '../invoices/types';
import { POSITIVE, today } from '../payments/types';

export interface Expense {
  id: string; description: string; amount: string; currencyCode: string; expenseDate: string; status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  paymentStatus: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID'; paidAt: string | null; categoryId: string;
  category: { id: string; name: string; costTreatment: string } | null; cashAccount: { id: string; name: string } | null;
  vendor?: { id: string; name: string } | null;
  isBilled: boolean; billedOn: { id: string; invoiceNumber: string; status: string } | null;
}

/** Record a cost against the file, or edit a draft one (`expense`). */
export function ExpenseForm({ fileId, expense, baseCurrency, onSaved, onCancel }: {
  fileId: string; expense?: Expense; baseCurrency: string; onSaved: () => void | Promise<void>; onCancel: () => void;
}) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const canPickVendor = can(permissions, 'clients.view'); // the party list is behind the same permission as clients
  const [vendorId, setVendorId] = useState(expense?.vendor?.id ?? '');
  const [categoryId, setCategoryId] = useState(expense?.categoryId ?? '');
  const [description, setDescription] = useState(expense?.description ?? '');
  const [amount, setAmount] = useState(expense ? expense.amount.replace(/\.?0+$/, '') : '');
  const [currency, setCurrency] = useState(expense?.currencyCode ?? baseCurrency);
  const [date, setDate] = useState(expense ? expense.expenseDate.slice(0, 10) : today());
  const [touched, setTouched] = useState(false);

  const currencies = useQuery({ queryKey: ['currencies'], queryFn: () => api.get<Currency[]>('/currencies') });
  const categories = useQuery({ queryKey: ['financial-categories'], queryFn: () => api.get<Category[]>('/financial-categories') });
  // Fees the office earns are not costs; the API refuses them here, so they are not offered.
  const costCategories = (categories.data ?? []).filter((c) => c.isActive && c.costTreatment !== 'OFFICE_REVENUE');
  const picked = costCategories.find((c) => c.id === categoryId);

  const save = useMutation({
    mutationFn: () => {
      const common = { categoryId, description: description.trim(), amount: amount.trim(), currencyCode: currency, expenseDate: date || undefined, ...(canPickVendor ? { vendorId: vendorId || (expense ? null : undefined) } : {}) };
      return expense ? api.patch(`/expenses/${expense.id}`, common) : api.post('/expenses', { ...common, clearanceFileId: fileId });
    },
    onSuccess: async () => { await onSaved(); },
  });
  const errors = {
    category: !categoryId ? t('exp.categoryRequired') : undefined,
    description: !description.trim() ? t('inv.descriptionRequired') : undefined,
    amount: !POSITIVE(amount) ? t('pay.amountInvalid') : undefined,
  };
  const valid = !errors.category && !errors.description && !errors.amount;

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{expense ? t('exp.editDraft') : t('exp.record')}</h2>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('inv.category')} htmlFor="exp-category" error={touched ? errors.category : undefined}
            hint={picked ? t(picked.costTreatment === 'PASS_THROUGH' ? 'exp.passThroughHint' : 'exp.officeHint') : undefined}>
            <Select id="exp-category" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="" />
              {costCategories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label={t('inv.description')} htmlFor="exp-description" error={touched ? errors.description : undefined}>
            <Input id="exp-description" dir="auto" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          {canPickVendor && <Field label={t('exp.vendor')} htmlFor="exp-vendor"><PartyPicker id="exp-vendor" value={vendorId} current={expense?.vendor} onChange={setVendorId} /></Field>}
          <Field label={t('pay.amount')} htmlFor="exp-amount" error={touched ? errors.amount : undefined}>
            <Input id="exp-amount" inputMode="decimal" dir="ltr" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Field>
          <Field label={t('inv.currency')} htmlFor="exp-currency">
            <Select id="exp-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
              {(currencies.data ?? [{ code: baseCurrency, name: baseCurrency, decimalPlaces: 2 }]).map((c) => <option key={c.code} value={c.code}>{c.code}</option>)}
            </Select>
          </Field>
          <Field label={t('pay.date')} htmlFor="exp-date"><Input id="exp-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{expense ? t('common.save') : t('exp.save')}</Button>
          <Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}
