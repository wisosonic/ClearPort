import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import type { Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, Spinner, Textarea } from '@/components/ui/primitives';
import { stageName, type Blocker, type FileDetail, type TransitionOption } from '../lib';

const errMsg = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

/** Blocker text from the API is English; codes we know get a translated line, the rest fall back to the server message. */
function BlockerList({ blockers }: { blockers: Blocker[] }) {
  const { t, i18n } = useTranslation();
  return (
    <ul className="list-disc space-y-0.5 ps-5 text-xs text-slate-600">
      {blockers.map((b, i) => {
        const docs = b.code === 'REQUIRED_DOCUMENTS_MISSING' && Array.isArray(b.details) ? (b.details as { nameEn: string; nameAr: string | null }[]) : null;
        return (
          <li key={`${b.code}-${i}`}>
            {t(`files.blockers.${b.code}`, { defaultValue: b.message })}
            {docs && <span dir="auto">: {docs.map((d) => (i18n.language === 'ar' && d.nameAr ? d.nameAr : d.nameEn)).join(', ')}</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function StagePanel({ file }: { file: FileDetail }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const qc = useQueryClient();
  const canClose = can(permissions, 'clearance_files.close');
  const [pending, setPending] = useState<TransitionOption | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [closing, setClosing] = useState(false);

  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['file', file.id] }),
    qc.invalidateQueries({ queryKey: ['file-transitions', file.id] }),
    qc.invalidateQueries({ queryKey: ['file-closure', file.id] }),
    qc.invalidateQueries({ queryKey: ['file-timeline', file.id] }),
    qc.invalidateQueries({ queryKey: ['file-history', file.id] }),
    qc.invalidateQueries({ queryKey: ['files'] }),
  ]);

  const options = useQuery({
    queryKey: ['file-transitions', file.id],
    queryFn: () => api.get<{ transitions: TransitionOption[] }>(`/clearance-files/${file.id}/transitions`),
    enabled: file.status === 'OPEN',
  });
  const closure = useQuery({
    queryKey: ['file-closure', file.id],
    queryFn: () => api.get<{ canClose: boolean; blockers: Blocker[]; warnings: Blocker[] }>(`/clearance-files/${file.id}/closure-check`),
    enabled: file.status === 'OPEN' && canClose && !!file.currentStage?.isTerminal,
  });

  const move = useMutation({
    mutationFn: (o: TransitionOption) => api.post(`/clearance-files/${file.id}/transition`, { toStageId: o.toStage.id, reason: reason.trim() || undefined }),
    onSuccess: async () => { setPending(null); setReason(''); await refresh(); },
  });
  const close = useMutation({
    mutationFn: () => api.post(`/clearance-files/${file.id}/close`, { note: note.trim() || undefined, acknowledgeOutstanding: acknowledge }),
    onSuccess: async () => { setClosing(false); setNote(''); setAcknowledge(false); await refresh(); },
  });
  const reopen = useMutation({
    mutationFn: () => api.post(`/clearance-files/${file.id}/reopen`, { reason: reason.trim() }),
    onSuccess: async () => { setReason(''); await refresh(); },
  });

  const choose = (o: TransitionOption) => {
    if (o.requiresReason) { setPending(o); return; }
    move.mutate(o);
  };
  const outstanding = closure.data?.warnings.some((w) => w.code === 'OUTSTANDING_BALANCE') ?? false;

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{t('files.stage')}</h2>
        <Badge tone="blue" dir="auto">{stageName(file.currentStage, locale)}</Badge>
      </div>

      {file.status === 'OPEN' && (
        <div className="space-y-3">
          {options.isPending && <Spinner />}
          {options.isError && <Alert>{errMsg(options.error, t('common.error'))}</Alert>}
          {options.data && options.data.transitions.length === 0 && !file.currentStage?.isTerminal && <p className="text-sm text-slate-500">{t('files.noTransitions')}</p>}
          <ul className="space-y-3">
            {options.data?.transitions.map((o) => (
              <li key={o.transitionId} className="space-y-1">
                <Button variant="secondary" disabled={!o.allowed || move.isPending} onClick={() => choose(o)}>
                  <ArrowRight className="rtl-flip size-4" aria-hidden />
                  {t('files.moveTo', { stage: stageName(o.toStage, locale) })}
                </Button>
                {!o.allowed && <BlockerList blockers={o.blockers} />}
              </li>
            ))}
          </ul>
          {pending && (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <label htmlFor="move-reason" className="block text-sm font-medium">{t('files.reason')}</label>
              <Textarea id="move-reason" dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2">
                <Button disabled={reason.trim().length < 3} loading={move.isPending} onClick={() => move.mutate(pending)}>{t('common.confirm')}</Button>
                <Button variant="secondary" onClick={() => { setPending(null); setReason(''); }}>{t('common.cancel')}</Button>
              </div>
            </div>
          )}
          {move.isError && <Alert>{errMsg(move.error, t('common.error'))}</Alert>}
        </div>
      )}

      {file.status === 'OPEN' && canClose && file.currentStage?.isTerminal && (
        <div className="space-y-2 border-t border-slate-200 pt-3">
          {closure.isPending && <Spinner />}
          {closure.data && closure.data.blockers.length > 0 && <Alert tone="amber"><BlockerList blockers={closure.data.blockers} /></Alert>}
          {closure.data && closure.data.warnings.length > 0 && <Alert tone="amber">{t('files.blockers.OUTSTANDING_BALANCE')}</Alert>}
          {!closing ? (
            <Button disabled={!closure.data?.canClose} onClick={() => setClosing(true)}>{t('files.close')}</Button>
          ) : (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <label htmlFor="close-note" className="block text-sm font-medium">{t('files.closeNote')}</label>
              <Textarea id="close-note" dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
              {outstanding && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />
                  {t('files.acknowledge')}
                </label>
              )}
              <div className="flex gap-2">
                <Button disabled={outstanding && !acknowledge} loading={close.isPending} onClick={() => close.mutate()}>{t('files.close')}</Button>
                <Button variant="secondary" onClick={() => setClosing(false)}>{t('common.cancel')}</Button>
              </div>
            </div>
          )}
          {close.isError && <Alert>{errMsg(close.error, t('common.error'))}</Alert>}
        </div>
      )}

      {file.status === 'CLOSED' && canClose && (
        <div className="space-y-2">
          <label htmlFor="reopen-reason" className="block text-sm font-medium">{t('files.reopenReason')}</label>
          <Textarea id="reopen-reason" dir="auto" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button variant="secondary" disabled={reason.trim().length < 3} loading={reopen.isPending} onClick={() => reopen.mutate()}>{t('files.reopen')}</Button>
          {reopen.isError && <Alert>{errMsg(reopen.error, t('common.error'))}</Alert>}
        </div>
      )}
      {(file.status === 'CANCELLED' || file.status === 'ON_HOLD') && <p className="text-sm text-slate-500">{t('files.notActive', { status: t(`files.statuses.${file.status}`) })}</p>}
    </Card>
  );
}
