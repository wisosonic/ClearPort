import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { useDebounced } from '@/hooks/useDebounced';
import { Input, Select } from '@/components/ui/primitives';

interface ClientOption { id: string; clientCode: string; name: string }

/** Search-then-choose client selector. Only active clients are offered. */
export function ClientPicker({ id, value, onChange, invalid }: { id: string; value: string; onChange: (id: string) => void; invalid?: boolean }) {
  const { t } = useTranslation();
  const [term, setTerm] = useState('');
  const search = useDebounced(term.trim());
  const q = useQuery({
    queryKey: ['client-options', search],
    queryFn: ({ signal }) => api.list<ClientOption>('/clients', { search, isActive: 'true', limit: 25 }, signal),
  });
  const options = q.data?.data ?? [];
  return (
    <div className="space-y-2">
      <Input type="search" aria-label={t('files.clientSearch')} placeholder={t('files.clientSearch')} value={term} onChange={(e) => setTerm(e.target.value)} />
      <Select id={id} aria-invalid={invalid} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{q.isPending ? t('common.loading') : t('files.pickClient')}</option>
        {options.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.clientCode})</option>)}
      </Select>
    </div>
  );
}
