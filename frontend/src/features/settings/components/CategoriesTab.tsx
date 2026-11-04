import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Td, Th } from '@/components/ui/primitives';

interface Category { id: string; name: string; categoryType: string; costTreatment: 'PASS_THROUGH' | 'OFFICE_EXPENSE' | 'OFFICE_REVENUE'; isBillableToClient: boolean; isTaxable: boolean; isActive: boolean }
const TYPES = ['CUSTOMS_DUTY_TAX', 'PORT_FEE', 'SHIPPING_FEE', 'TRANSPORTATION', 'SERVICE_FEE', 'INSPECTION', 'STORAGE', 'OTHER'] as const;
const TREATMENTS = ['PASS_THROUGH', 'OFFICE_EXPENSE', 'OFFICE_REVENUE'] as const;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Add a category, or edit one (`category`; its type and treatment are fixed once transactions may rely on them). */
function CategoryForm({ category, onDone }: { category?: Category; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(category?.name ?? '');
  const [type, setType] = useState<string>(category?.categoryType ?? 'SERVICE_FEE');
  const [treatment, setTreatment] = useState<string>(category?.costTreatment ?? 'OFFICE_REVENUE');
  const [billable, setBillable] = useState(category?.isBillableToClient ?? true);
  const [taxable, setTaxable] = useState(category?.isTaxable ?? false);
  const [touched, setTouched] = useState(false);
  const nameBad = name.trim().length < 2;
  const save = useMutation({
    mutationFn: () => (category
      ? api.patch(`/financial-categories/${category.id}`, { name: name.trim(), isBillableToClient: billable, isTaxable: taxable })
      : api.post('/financial-categories', { name: name.trim(), categoryType: type, costTreatment: treatment, isBillableToClient: billable, isTaxable: taxable })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['financial-categories'] }); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!nameBad) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{category ? t('settings.editCategory') : t('settings.addCategory')}</h2>
        {save.isError && <Alert>{errText(save.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('common.name')} htmlFor="cat-name" error={touched && nameBad ? t('acc.nameShort') : undefined}><Input id="cat-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('settings.categoryType')} htmlFor="cat-type"><Select id="cat-type" value={type} disabled={!!category} onChange={(e) => setType(e.target.value)}>{TYPES.map((x) => <option key={x} value={x}>{t(`settings.categoryTypes.${x}`)}</option>)}</Select></Field>
          <Field label={t('settings.treatment')} htmlFor="cat-treatment" hint={t(`settings.treatmentHints.${treatment}`)}>
            <Select id="cat-treatment" value={treatment} disabled={!!category} onChange={(e) => setTreatment(e.target.value)}>{TREATMENTS.map((x) => <option key={x} value={x}>{t(`settings.treatments.${x}`)}</option>)}</Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={billable} onChange={(e) => setBillable(e.target.checked)} />{t('settings.billable')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={taxable} onChange={(e) => setTaxable(e.target.checked)} />{t('settings.taxable')}</label>
        </div>
        {category && <p className="text-xs text-slate-500">{t('settings.categoryFixed')}</p>}
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

function CategoryRow({ c, onEdit }: { c: Category; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: () => api.patch(`/financial-categories/${c.id}`, { isActive: !c.isActive }),
    onSuccess: async () => { setProblem(null); await qc.invalidateQueries({ queryKey: ['financial-categories'] }); },
    onError: (e) => setProblem(errText(e, t('common.error'))),
  });
  return (
    <>
      <tr className={c.isActive ? '' : 'text-slate-400'}>
        <Td dir="auto" className="font-medium">{c.name}</Td>
        <Td>{t(`settings.categoryTypes.${c.categoryType}`, { defaultValue: c.categoryType })}</Td>
        <Td>{t(`settings.treatments.${c.costTreatment}`)}</Td>
        <Td>{c.isBillableToClient ? t('settings.yes') : t('settings.no')}</Td>
        <Td>{c.isTaxable ? t('settings.yes') : t('settings.no')}</Td>
        <Td><Badge tone={c.isActive ? 'green' : 'neutral'}>{c.isActive ? t('common.active') : t('common.inactive')}</Badge></Td>
        <Td>
          <div className="flex gap-1">
            <Button variant="ghost" aria-label={`${t('common.edit')} ${c.name}`} onClick={onEdit}>{t('common.edit')}</Button>
            <Button variant="ghost" aria-label={`${c.isActive ? t('clients.deactivate') : t('clients.reactivate')} ${c.name}`} loading={toggle.isPending} onClick={() => toggle.mutate()}>{c.isActive ? t('clients.deactivate') : t('clients.reactivate')}</Button>
          </div>
        </Td>
      </tr>
      {problem && <tr><td colSpan={7} className="px-4 py-2"><Alert>{problem}</Alert></td></tr>}
    </>
  );
}

export function CategoriesTab() {
  const { t } = useTranslation();
  const [form, setForm] = useState<'new' | Category | null>(null);
  const q = useQuery({ queryKey: ['financial-categories', 'all'], queryFn: ({ signal }) => api.get<Category[]>('/financial-categories', { includeInactive: 'true' }, signal) });
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">{t('settings.categoriesIntro')}</p>
      {!form && <div><Button onClick={() => setForm('new')}><Plus className="size-4" aria-hidden />{t('settings.addCategory')}</Button></div>}
      {form && <CategoryForm category={form === 'new' ? undefined : form} onDone={() => setForm(null)} />}
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.length === 0 ? <EmptyState>{t('settings.noCategories')}</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="border-b border-slate-200 bg-slate-50"><tr><Th>{t('common.name')}</Th><Th>{t('settings.categoryType')}</Th><Th>{t('settings.treatment')}</Th><Th>{t('settings.billable')}</Th><Th>{t('settings.taxable')}</Th><Th>{t('common.status')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr></thead>
              <tbody className="divide-y divide-slate-100">{q.data.map((c) => <CategoryRow key={c.id} c={c} onEdit={() => setForm(c)} />)}</tbody>
            </table>
          </div>
        ))}
      </Card>
    </div>
  );
}
