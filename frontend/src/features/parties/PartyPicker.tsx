import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { useDebounced } from '@/hooks/useDebounced';
import { Input, Select } from '@/components/ui/primitives';
import type { Party, PartyType } from './types';

/** Choose one business party, of a given kind (a shipping agent, a freight forwarder...) or of any kind when `type` is left out, searching by name. */
export function PartyPicker({ id, type, value, current, onChange }: {
  id: string; type?: PartyType; value: string; current?: { id: string; name: string } | null; onChange: (v: string) => void;
}) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim());
  const q = useQuery({ queryKey: ['parties', type ?? 'any', search], queryFn: ({ signal }) => api.list<Party>('/parties', { partyType: type, search, limit: 25 }, signal) });
  const options = q.data?.data ?? [];
  // The one already chosen stays selectable even when a search no longer lists it.
  const shown = current && !options.some((o) => o.id === current.id) ? [current, ...options] : options;
  return (
    <div className="space-y-1">
      <Input type="search" aria-label={`${t('parties.search')} (${id})`} placeholder={t('parties.search')} value={term} onChange={(e) => setTerm(e.target.value)} />
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {shown.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </Select>
    </div>
  );
}
