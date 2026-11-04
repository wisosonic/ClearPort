import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, formatMoney, type Locale } from '@/lib/format';
import { Alert, Card, EmptyState, ErrorState, Field, Input, Select, Spinner, Td, Th } from '@/components/ui/primitives';
import type { Balance, Statement } from '../types';

/** What the client owes and holds, per currency (the API never adds currencies together), and their statement. */
export function AccountTab({ clientId }: { clientId: string }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const [currency, setCurrency] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const balance = useQuery({ queryKey: ['client-balance', clientId], queryFn: ({ signal }) => api.get<Balance>(`/clients/${clientId}/balance`, undefined, signal) });
  const statement = useQuery({
    queryKey: ['client-statement', clientId, { currency, from, to }],
    queryFn: ({ signal }) => api.get<Statement>(`/clients/${clientId}/statement`, { currency: currency || undefined, from: from || undefined, to: to || undefined }, signal),
  });
  const money = (v: string, c: string) => formatMoney(v, c, locale);

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        <h2 className="border-b border-slate-200 px-5 py-3 text-sm font-semibold text-slate-700">{t('clients.balance')}</h2>
        {balance.isPending && <Spinner />}
        {balance.isError && <ErrorState error={balance.error} onRetry={() => void balance.refetch()} />}
        {balance.data && (
          <>
            {balance.data.creditLimit && <p className="px-5 pt-3 text-sm text-slate-600">{t('clients.creditLimit')}: <span dir="ltr">{formatMoney(balance.data.creditLimit, undefined, locale)}</span></p>}
            {balance.data.balances.length === 0 ? <EmptyState>{t('clients.noActivity')}</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr><Th>{t('inv.currency')}</Th><Th>{t('clients.invoiced')}</Th><Th>{t('clients.received')}</Th><Th>{t('clients.refunded')}</Th><Th>{t('inv.outstanding')}</Th><Th>{t('clients.heldCredit')}</Th><Th>{t('clients.net')}</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {balance.data.balances.map((b) => (
                      <tr key={b.currency}>
                        <Td dir="ltr" className="font-medium">{b.currency}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(b.invoiced, b.currency)}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(b.received, b.currency)}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(b.refunded, b.currency)}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(b.outstanding, b.currency)}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(b.unappliedCredit, b.currency)}</Td>
                        <Td dir="ltr" className="font-medium tabular-nums">{money(b.netBalance, b.currency)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-5 py-3 text-xs text-slate-500">{t('clients.netNote')}</p>
          </>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="space-y-3 border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{t('clients.statement')}</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('inv.currency')} htmlFor="st-currency">
              <Select id="st-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                <option value="">{t('common.all')}</option>
                {(balance.data?.balances ?? []).map((b) => <option key={b.currency} value={b.currency}>{b.currency}</option>)}
              </Select>
            </Field>
            <Field label={t('clients.from')} htmlFor="st-from"><Input id="st-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label={t('clients.to')} htmlFor="st-to"><Input id="st-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
        </div>
        {statement.isPending && <Spinner />}
        {statement.isError && <ErrorState error={statement.error} onRetry={() => void statement.refetch()} />}
        {statement.data && (
          <>
            {Object.keys(statement.data.openingBalances).length > 0 && (
              <Alert tone="blue">{t('clients.opening')}: {Object.entries(statement.data.openingBalances).map(([c, v]) => money(v, c)).join(' · ')}</Alert>
            )}
            {statement.data.lines.length === 0 ? <EmptyState>{t('clients.noActivity')}</EmptyState> : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="border-b border-slate-200 bg-slate-50">
                    <tr><Th>{t('pay.date')}</Th><Th>{t('clients.reference')}</Th><Th>{t('inv.description')}</Th><Th>{t('clients.debit')}</Th><Th>{t('clients.credit')}</Th><Th>{t('clients.runningBalance')}</Th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {statement.data.lines.map((l, i) => (
                      <tr key={`${l.reference}-${i}`}>
                        <Td>{formatDate(l.date, locale)}</Td>
                        <Td dir="ltr" className="tabular-nums">{l.reference}</Td>
                        <Td dir="auto">{l.description}</Td>
                        <Td dir="ltr" className="tabular-nums">{Number(l.debit) ? money(l.debit, l.currency) : ''}</Td>
                        <Td dir="ltr" className="tabular-nums">{Number(l.credit) ? money(l.credit, l.currency) : ''}</Td>
                        <Td dir="ltr" className="tabular-nums">{money(l.balance, l.currency)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {Object.keys(statement.data.closingBalances).length > 0 && (
              <p className="px-5 py-3 text-sm font-medium">{t('clients.closing')}: <span dir="ltr">{Object.entries(statement.data.closingBalances).map(([c, v]) => money(v, c)).join(' · ')}</span></p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
