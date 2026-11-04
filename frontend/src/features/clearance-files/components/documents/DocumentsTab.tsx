import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileUp, RotateCcw, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, ApiError, download } from '@/lib/api-client';
import { saveBlob } from '@/lib/save-blob';
import { formatBytes, formatDate, fullName, type Locale } from '@/lib/format';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { Alert, Badge, Button, Card, EmptyState, ErrorState, Field, Pagination, Select, Spinner, Td, Textarea, Th } from '@/components/ui/primitives';
import { stageName, type FileDetail } from '../../lib';
import type { ChecklistItem, DocType, DocumentRow } from './types';

const docTone = { PENDING_REVIEW: 'amber', APPROVED: 'green', REJECTED: 'red', VOID: 'neutral' } as const;
const stateTone = { MISSING: 'red', REJECTED_ONLY: 'red', UPLOADED: 'amber', APPROVED: 'green' } as const;
const LIMIT = 20;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);
const typeName = (t: { nameEn: string; nameAr: string }, locale: Locale) => (locale === 'ar' ? t.nameAr : t.nameEn);

function useRefresh(fileId: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['file-documents', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-checklist', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-transitions', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-closure', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-summary', fileId] }),
    qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }),
  ]);
}

// ───────────────────────────── checklist ─────────────────────────────

function Checklist({ fileId, canUpload, onUpload }: { fileId: string; canUpload: boolean; onUpload: (typeId: string) => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const q = useQuery({ queryKey: ['file-checklist', fileId], queryFn: () => api.get<ChecklistItem[]>(`/clearance-files/${fileId}/document-requirements`) });
  const missing = q.data?.filter((c) => c.isRequired && !c.satisfied).length ?? 0;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold text-slate-700">{t('docs.checklist')}</h2>
        {q.data && q.data.length > 0 && (missing > 0
          ? <Badge tone="red">{t('docs.missingCount', { count: missing })}</Badge>
          : <Badge tone="green">{t('docs.complete')}</Badge>)}
      </div>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.length === 0 && <p className="text-sm text-slate-500">{t('docs.noRequirements')}</p>}
      <ul className="divide-y divide-slate-100">
        {q.data?.map((c) => (
          <li key={c.requirementId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <div>
              <span dir="auto" className="font-medium">{typeName(c.documentType, locale)}</span>
              <span className="ms-2 text-xs text-slate-500">
                {c.isRequired ? t('docs.required') : t('docs.optional')}
                {c.requiredBeforeStage ? ` · ${t('docs.beforeStage', { stage: stageName(c.requiredBeforeStage, locale) })}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone={stateTone[c.state]}>{t(`docs.states.${c.state}`)}</Badge>
              {canUpload && !c.satisfied && <Button variant="ghost" onClick={() => onUpload(c.documentType.id)}>{t('docs.upload')}</Button>}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────────────────────────── upload ─────────────────────────────

function UploadForm({ fileId, presetType, onDone }: { fileId: string; presetType: string; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const refresh = useRefresh(fileId);
  const input = useRef<HTMLInputElement>(null);
  const [typeId, setTypeId] = useState(presetType);
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState('');
  const [touched, setTouched] = useState(false);
  const types = useQuery({ queryKey: ['document-types'], queryFn: () => api.get<DocType[]>('/document-types') });
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('documentTypeId', typeId);
      if (notes.trim()) form.append('notes', notes.trim());
      form.append('file', file as File);
      return api.upload(`/clearance-files/${fileId}/documents`, form);
    },
    onSuccess: async () => { await refresh(); onDone(); },
  });
  const ready = !!typeId && !!file;

  return (
    <Card className="p-5">
      <form onSubmit={(e) => { e.preventDefault(); setTouched(true); if (ready) upload.mutate(); }} className="space-y-4" noValidate>
        <h2 className="text-sm font-semibold text-slate-700">{t('docs.uploadTitle')}</h2>
        {upload.isError && <Alert>{errText(upload.error, t('common.error'))}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('docs.type')} htmlFor="doc-type" error={touched && !typeId ? t('docs.typeRequired') : undefined}>
            <Select id="doc-type" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
              <option value="">{t('docs.pickType')}</option>
              {(types.data ?? []).filter((x) => x.isActive).map((x) => <option key={x.id} value={x.id}>{typeName(x, locale)}</option>)}
            </Select>
          </Field>
          <Field label={t('docs.file')} htmlFor="doc-file" error={touched && !file ? t('docs.fileRequired') : undefined}>
            <input ref={input} id="doc-file" type="file" className="block w-full text-sm file:me-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium hover:file:bg-slate-200"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </Field>
        </div>
        <Field label={t('docs.notes')} htmlFor="doc-notes"><Textarea id="doc-notes" dir="auto" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="flex gap-2">
          <Button type="submit" loading={upload.isPending}><FileUp className="size-4" aria-hidden />{t('docs.upload')}</Button>
          <Button type="button" variant="secondary" onClick={onDone}>{t('common.cancel')}</Button>
        </div>
      </form>
    </Card>
  );
}

// ───────────────────────────── one document row ─────────────────────────────

function DocumentRowItem({ doc, fileId, editable }: { doc: DocumentRow; fileId: string; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const { permissions } = useAuth();
  const refresh = useRefresh(fileId);
  const versionInput = useRef<HTMLInputElement>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (e: unknown) => setProblem(errText(e, t('common.error')));

  const get = useMutation({
    mutationFn: async () => { const { blob, filename } = await download(`/documents/${doc.id}/download`); saveBlob(blob, filename ?? doc.originalFilename); },
    onError: fail,
  });
  const review = useMutation({
    mutationFn: (v: { status: 'APPROVED' | 'REJECTED' | 'PENDING_REVIEW'; note?: string }) => api.patch(`/documents/${doc.id}/status`, v),
    onSuccess: async () => { setRejecting(false); setNote(''); setProblem(null); await refresh(); },
    onError: fail,
  });
  const version = useMutation({
    mutationFn: (f: File) => { const form = new FormData(); form.append('file', f); return api.upload(`/documents/${doc.id}/versions`, form); },
    onSuccess: async () => { setProblem(null); await refresh(); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/documents/${doc.id}`),
    onSuccess: async () => { setConfirmVoid(false); await refresh(); },
    onError: fail,
  });

  const canReview = editable && can(permissions, 'documents.review');
  const canVersion = editable && can(permissions, 'documents.upload');
  const canVoid = editable && can(permissions, 'documents.delete');

  return (
    <>
      <tr>
        <Td dir="auto"><span className="font-medium">{typeName(doc.documentType, locale)}</span></Td>
        <Td dir="auto" className="max-w-xs break-words">{doc.originalFilename}{doc.notes && <span className="block text-xs text-slate-500">{doc.notes}</span>}</Td>
        <Td>v{doc.versionNumber}</Td>
        <Td dir="ltr">{formatBytes(doc.fileSize)}</Td>
        <Td><Badge tone={docTone[doc.status as keyof typeof docTone] ?? 'neutral'}>{t(`docs.statuses.${doc.status}`)}</Badge></Td>
        <Td dir="auto">{doc.uploadedBy ? fullName(doc.uploadedBy) : '—'}<span className="block text-xs text-slate-500">{formatDate(doc.uploadedAt, locale)}</span></Td>
        <Td>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" aria-label={`${t('docs.download')} ${doc.originalFilename}`} loading={get.isPending} onClick={() => get.mutate()}><Download className="size-4" aria-hidden /></Button>
            {canReview && doc.status !== 'APPROVED' && <Button variant="ghost" aria-label={`${t('docs.approve')} ${doc.originalFilename}`} loading={review.isPending} onClick={() => review.mutate({ status: 'APPROVED' })}><Check className="size-4 text-green-700" aria-hidden /></Button>}
            {canReview && doc.status !== 'REJECTED' && <Button variant="ghost" aria-label={`${t('docs.reject')} ${doc.originalFilename}`} onClick={() => setRejecting(true)}><X className="size-4 text-red-700" aria-hidden /></Button>}
            {canReview && doc.status !== 'PENDING_REVIEW' && <Button variant="ghost" aria-label={`${t('docs.returnToReview')} ${doc.originalFilename}`} onClick={() => review.mutate({ status: 'PENDING_REVIEW' })}><RotateCcw className="size-4" aria-hidden /></Button>}
            {canVersion && (
              <>
                <input ref={versionInput} type="file" className="sr-only" tabIndex={-1} aria-label={`${t('docs.newVersion')} ${doc.originalFilename}`}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) version.mutate(f); e.target.value = ''; }} />
                <Button variant="ghost" loading={version.isPending} onClick={() => versionInput.current?.click()}>{t('docs.newVersion')}</Button>
              </>
            )}
            {canVoid && <Button variant="ghost" aria-label={`${t('docs.void')} ${doc.originalFilename}`} onClick={() => setConfirmVoid(true)}><Trash2 className="size-4 text-red-700" aria-hidden /></Button>}
          </div>
        </Td>
      </tr>
      {(rejecting || confirmVoid || problem) && (
        <tr>
          <td colSpan={7} className="space-y-2 bg-slate-50 px-4 py-3">
            {problem && <Alert>{problem}</Alert>}
            {rejecting && (
              <div className="space-y-2">
                <label htmlFor={`reject-${doc.id}`} className="block text-sm font-medium">{t('docs.rejectReason')}</label>
                <Textarea id={`reject-${doc.id}`} dir="auto" value={note} onChange={(e) => setNote(e.target.value)} />
                <div className="flex gap-2">
                  <Button disabled={note.trim().length < 3} loading={review.isPending} onClick={() => review.mutate({ status: 'REJECTED', note: note.trim() })}>{t('docs.reject')}</Button>
                  <Button variant="secondary" onClick={() => { setRejecting(false); setNote(''); }}>{t('common.cancel')}</Button>
                </div>
              </div>
            )}
            {confirmVoid && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span>{t('docs.voidConfirm')}</span>
                <Button loading={remove.isPending} onClick={() => remove.mutate()}>{t('docs.void')}</Button>
                <Button variant="secondary" onClick={() => setConfirmVoid(false)}>{t('common.cancel')}</Button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ───────────────────────────── tab ─────────────────────────────

export function DocumentsTab({ file }: { file: FileDetail }) {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  const [page, setPage] = useState(1);
  const [uploading, setUploading] = useState<string | null>(null); // preset type id; '' = no preset
  const editable = file.status === 'OPEN' || file.status === 'ON_HOLD';
  const canUpload = editable && can(permissions, 'documents.upload');
  const q = useQuery({
    queryKey: ['file-documents', file.id, page],
    queryFn: ({ signal }) => api.list<DocumentRow>(`/clearance-files/${file.id}/documents`, { page, limit: LIMIT }, signal),
  });

  return (
    <div className="space-y-4">
      {!editable && <Alert tone="blue">{t('docs.readOnly')}</Alert>}
      <Checklist fileId={file.id} canUpload={canUpload} onUpload={(typeId) => setUploading(typeId)} />
      {uploading !== null && <UploadForm fileId={file.id} presetType={uploading} onDone={() => setUploading(null)} />}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-sm font-semibold text-slate-700">{t('docs.title')}</h2>
          {canUpload && uploading === null && <Button onClick={() => setUploading('')}><FileUp className="size-4" aria-hidden />{t('docs.upload')}</Button>}
        </div>
        {q.isPending && <Spinner />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data && (q.data.data.length === 0 ? <EmptyState>{t('docs.none')}</EmptyState> : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b border-slate-200 bg-slate-50">
                  <tr><Th>{t('docs.type')}</Th><Th>{t('docs.file')}</Th><Th>{t('docs.version')}</Th><Th>{t('docs.size')}</Th><Th>{t('common.status')}</Th><Th>{t('docs.uploadedBy')}</Th><Th><span className="sr-only">{t('common.actions')}</span></Th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {q.data.data.map((d) => <DocumentRowItem key={d.id} doc={d} fileId={file.id} editable={editable} />)}
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
