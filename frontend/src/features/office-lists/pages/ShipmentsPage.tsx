import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, type Locale } from '@/lib/format';
import { useDebounced } from '@/hooks/useDebounced';
import { Badge, Card, EmptyState, ErrorState, Input, Pagination, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import type { Shipment } from '@/features/clearance-files/components/shipments/types';

type Row = Shipment & { clearanceFile: { id: string; fileNumber: string; status: string; client: { id: string; name: string } } };
const TYPES = ['SEA', 'AIR', 'LAND', 'OTHER'] as const;
const LIMIT = 20;

/** Every shipment in the office. Shipments are edited on their file page, which each row links to. */
export function ShipmentsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [arrived, setArrived] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim());
  const q = useQuery({
    queryKey: ['shipments', { term, type, arrived, from, to, page }],
    queryFn: ({ signal }) => api.list<Row>('/shipments', { search: term, shipmentType: type, arrived, from, to, page, limit: LIMIT, sort: 'eta:asc' }, signal),
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('nav.shipments')}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-60 flex-1">
          <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-slate-400" aria-hidden />
          <Input className="ps-9" type="search" aria-label={t('common.search')} placeholder={t('lists.shipmentSearch')} value={search} onChange={(e) => reset(setSearch)(e.target.value)} />
        </div>
        <Select aria-label={t('ship.type')} className="w-36" value={type} onChange={(e) => reset(setType)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          {TYPES.map((x) => <option key={x} value={x}>{t(`files.shipmentTypes.${x}`)}</option>)}
        </Select>
        <Select aria-label={t('lists.arrival')} className="w-44" value={arrived} onChange={(e) => reset(setArrived)(e.target.value)}>
          <option value="">{t('common.all')}</option>
          <option value="false">{t('lists.notArrived')}</option>
          <option value="true">{t('lists.arrived')}</option>
        </Select>
        <Input type="date" aria-label={`${t('ship.eta')} ${t('clients.from')}`} className="w-40" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        <Input type="date" aria-label={`${t('ship.eta')} ${t('clients.to')}`} className="w-40" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
      </div>
      <Card className="overflow-hidden">
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('lists.noShipments')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('files.number')}</Th><Th>{t('files.client')}</Th><Th>{t('ship.type')}</Th><Th>{t('ship.bl')}</Th><Th>{t('ship.vessel')}</Th><Th>{t('lists.route')}</Th><Th>{t('ship.eta')}</Th><Th>{t('ship.containers')}</Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <Td dir="ltr" className="font-medium tabular-nums"><Link to={`/files/${s.clearanceFile.id}`} className="text-brand-700 hover:underline">{s.clearanceFile.fileNumber}</Link></Td>
                      <Td dir="auto">{s.clearanceFile.client.name}</Td>
                      <Td>{t(`files.shipmentTypes.${s.shipmentType}`, { defaultValue: s.shipmentType })}</Td>
                      <Td dir="ltr" className="tabular-nums">{s.billOfLadingNumber ?? s.masterBlNumber ?? s.houseBlNumber ?? '—'}</Td>
                      <Td dir="auto">{s.vesselName ?? '—'}{s.voyageNumber && <span className="block text-xs text-slate-500" dir="ltr">{s.voyageNumber}</span>}</Td>
                      <Td dir="ltr">{s.originPort || s.destinationPort ? `${s.originPort?.code ?? '?'} → ${s.destinationPort?.code ?? '?'}` : '—'}</Td>
                      <Td>
                        {formatDate(s.eta, locale)}
                        {s.actualArrivalAt && <Badge tone="green" className="ms-2">{t('lists.arrived')}</Badge>}
                      </Td>
                      <Td dir="ltr" className="tabular-nums">{s._count.containers}</Td>
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
