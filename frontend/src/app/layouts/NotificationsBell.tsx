import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '@/lib/api-client';
import { formatDate, type Locale } from '@/lib/format';

interface Notice { id: string; type: string; title: string; readAt: string | null; createdAt: string; metadata: { clearanceFileId?: string | null; taskId?: string } | null }

/** Where a notification leads: its file when it has one, otherwise the task list. */
const target = (n: Notice) => (n.metadata?.clearanceFileId ? `/files/${n.metadata.clearanceFileId}` : n.metadata?.taskId ? '/tasks' : null);

/** The bell in the header: unread count and the latest notifications. Checks for new ones every minute. */
export function NotificationsBell() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language as Locale;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications'], refetchInterval: 60_000,
    queryFn: ({ signal }) => api.list<Notice>('/notifications', { limit: 15 }, signal),
  });
  const unread = (q.data?.meta as { unreadCount?: number } | undefined)?.unreadCount ?? 0;
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({ mutationFn: (id: string) => api.post(`/notifications/${id}/read`), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api.post('/notifications/read-all'), onSuccess: refresh });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);

  const items = q.data?.data ?? [];
  return (
    <div ref={box} className="relative">
      <button
        type="button" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}
        aria-label={unread > 0 ? t('notifications.bellUnread', { count: unread }) : t('notifications.bell')}
        className="relative flex items-center rounded px-2 py-1.5 text-slate-600 hover:bg-slate-100"
      >
        <Bell className="size-4" aria-hidden />
        {unread > 0 && <span className="absolute -top-0.5 end-0 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-semibold leading-4 text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div role="region" aria-label={t('notifications.title')} className="absolute end-0 z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-slate-200 bg-white shadow-lg">
          <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
            <h2 className="text-sm font-semibold text-slate-700">{t('notifications.title')}</h2>
            {unread > 0 && <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => readAll.mutate()}>{t('notifications.markAll')}</button>}
          </div>
          {items.length === 0 ? <p className="p-4 text-center text-sm text-slate-500">{t('notifications.none')}</p> : (
            <ul className="max-h-96 divide-y divide-slate-100 overflow-y-auto">
              {items.map((n) => {
                const to = target(n);
                return (
                  <li key={n.id}>
                    <button
                      type="button" className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-start hover:bg-slate-50 ${n.readAt ? 'text-slate-500' : 'font-medium text-slate-900'}`}
                      onClick={() => { if (!n.readAt) read.mutate(n.id); if (to) { setOpen(false); navigate(to); } }}
                    >
                      <span className="text-sm" dir="auto">{n.title}</span>
                      <span className="text-xs font-normal text-slate-500">{formatDate(n.createdAt, locale)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
