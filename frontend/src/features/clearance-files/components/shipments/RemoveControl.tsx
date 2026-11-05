import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '@/lib/api-client';
import { Alert, Button } from '@/components/ui/primitives';

/** "Remove" with an inline confirmation, for something added to a file by mistake. */
export function RemoveControl({ fileId, path, label, question }: { fileId: string; path: string; label: string; question: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [asking, setAsking] = useState(false);
  const remove = useMutation({
    mutationFn: () => api.delete(path),
    onSuccess: async () => {
      setAsking(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['shipments', fileId] }), qc.invalidateQueries({ queryKey: ['shipment'] }), qc.invalidateQueries({ queryKey: ['file', fileId] }),
        qc.invalidateQueries({ queryKey: ['file-summary', fileId] }), qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }), qc.invalidateQueries({ queryKey: ['file-checklist', fileId] }),
      ]);
    },
  });
  if (!asking) return <Button variant="ghost" aria-label={`${t('ship.remove')} ${label}`} onClick={() => setAsking(true)}>{t('ship.remove')}</Button>;
  return (
    <div className="space-y-2 text-sm">
      {remove.isError && <Alert>{remove.error instanceof ApiError ? remove.error.message : t('common.error')}</Alert>}
      <p>{question}</p>
      <div className="flex gap-1">
        <Button loading={remove.isPending} onClick={() => remove.mutate()}>{t('ship.remove')}</Button>
        <Button variant="secondary" onClick={() => { setAsking(false); remove.reset(); }}>{t('common.cancel')}</Button>
      </div>
    </div>
  );
}
