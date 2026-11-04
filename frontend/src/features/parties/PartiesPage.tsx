import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { can } from '@/lib/permissions';
import { useDebounced } from '@/hooks/useDebounced';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Input, Pagination, Select, Spinner, Td, Textarea, Th } from '@/components/ui/primitives';
import { PARTY_TYPES, type Party, type PartyType } from './types';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMIT = 20;

/** Add a party, or edit one (`party`). Parties are not clients: a company can be both and the two records are independent. */
function PartyForm({ party, onDone }: { party?: Party; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState(party?.name ?? '');
  const [type, setType] = useState<PartyType>(party?.partyType ?? 'SHIPPING_AGENT');
  const [taxNumber, setTaxNumber] = useState(party?.taxNumber ?? '');
  const [phone, setPhone] = useState(party?.phone ?? '');
  const [email, setEmail] = useState(party?.email ?? '');
  const [address, setAddress] = useState(party?.address ?? '');
  const [country, setCountry] = useState(party?.countryCode ?? '');
  const [touched, setTouched] = useState(false);
  const errors = {
    name: !name.trim() ? t('clients.nameRequired') : undefined,
    email: email.trim() && !EMAIL.test(email.trim()) ? t('clients.emailInvalid') : undefined,
    country: country.trim() && !/^[A-Za-z]{2}$/.test(country.trim()) ? t('ship.invalidCountry') : undefined,
  };
  const valid = !Object.values(errors).some(Boolean);
  const save = useMutation({
    mutationFn: () => (party
      ? api.patch(`/parties/${party.id}`, {
        name: name.trim(), partyType: type, taxNumber: taxNumber.trim(), phone: phone.trim(), address: address.trim(),
        email: email.trim() || null, countryCode: country.trim().toUpperCase() || null,
      })
      : api.post('/parties', {
        name: name.trim(), partyType: type, taxNumber: taxNumber.trim(), phone: phone.trim(), address: address.trim(),
        ...(email.trim() ? { email: email.trim() } : {}), ...(country.trim() ? { countryCode: country.trim().toUpperCase() } : {}),
      })),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['parties'] }); onDone(); },
  });
  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (valid) save.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{party ? t('parties.edit') : t('parties.add')}</h2>
        {save.isError && <Alert>{save.error instanceof ApiError ? save.error.message : t('common.error')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.name')} htmlFor="party-name" error={touched ? errors.name : undefined}><Input id="party-name" dir="auto" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label={t('files.type')} htmlFor="party-type"><Select id="party-type" value={type} onChange={(e) => setType(e.target.value as PartyType)}>{PARTY_TYPES.map((x) => <option key={x} value={x}>{t(`parties.types.${x}`)}</option>)}</Select></Field>
          <Field label={t('clients.taxNumber')} htmlFor="party-tax"><Input id="party-tax" dir="ltr" value={taxNumber} onChange={(e) => setTaxNumber(e.target.value)} /></Field>
          <Field label={t('clients.phone')} htmlFor="party-phone"><Input id="party-phone" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label={t('clients.email')} htmlFor="party-email" error={touched ? errors.email : undefined}><Input id="party-email" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label={t('clients.country')} htmlFor="party-country" hint={t('clients.countryHint')} error={touched ? errors.country : undefined}><Input id="party-country" dir="ltr" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value)} /></Field>
        </div>
        <Field label={t('clients.address')} htmlFor="party-address"><Textarea id="party-address" dir="auto" value={address} onChange={(e) => setAddress(e.target.value)} /></Field>
        <div className="flex gap-2">
          <Button type="submit" loading={save.isPending}>{t('common.save')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

/** Shipping agents, freight forwarders, suppliers and transporters the office deals with. */
export function PartiesPage() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const canManage = can(permissions, 'clients.manage');
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<'new' | Party | null>(null);
  const term = useDebounced(search.trim());
  const q = useQuery({
    queryKey: ['parties', 'list', { term, type, page }],
    queryFn: ({ signal }) => api.list<Party>('/parties', { search: term, partyType: type, page, limit: LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t('parties.title')}</h1>
          <p className="text-sm text-slate-600">{t('parties.intro')}</p>
        </div>
        {canManage && !form && <Button onClick={() => setForm('new')}><Plus className="size-4" aria-hidden />{t('parties.add')}</Button>}
      </div>
      {form && <PartyForm party={form === 'new' ? undefined : form} onDone={() => setForm(null)} />}
      <div className="flex flex-wrap gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('parties.searchPlaceholder')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('files.type')} className="w-48" value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {PARTY_TYPES.map((x) => <option key={x} value={x}>{t(`parties.types.${x}`)}</option>)}
        </Select>
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('parties.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('common.name')}</Th><Th>{t('files.type')}</Th><Th>{t('clients.phone')}</Th><Th>{t('clients.email')}</Th><Th>{t('clients.country')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <Td dir="auto" className="font-medium">{p.name}{p.taxNumber && <span className="block text-xs text-slate-500" dir="ltr">{p.taxNumber}</span>}</Td>
                      <Td><Badge tone="neutral">{t(`parties.types.${p.partyType}`)}</Badge></Td>
                      <Td dir="ltr">{p.phone ?? '—'}</Td>
                      <Td dir="ltr">{p.email ?? '—'}</Td>
                      <Td dir="ltr">{p.countryCode ?? '—'}</Td>
                      <Td>{canManage && <Button variant="ghost" aria-label={`${t('common.edit')} ${p.name}`} onClick={() => setForm(p)}>{t('common.edit')}</Button>}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={q.data.meta.page} limit={q.data.meta.limit} total={q.data.meta.total} onPage={setPage} />
          </>
        ))}
      </Card>
    </div>
  );
}
