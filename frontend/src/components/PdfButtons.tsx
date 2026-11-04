import { useMutation } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ApiError, download } from '@/lib/api-client';
import { saveBlob } from '@/lib/save-blob';
import { Button } from '@/components/ui/primitives';

type Query = Record<string, string | undefined>;

/**
 * Download a printable PDF in English or in Arabic. A printed document goes to a client, so the language is
 * chosen per document rather than following the language of the screen.
 */
export function PdfButtons({ path, query, fallbackName }: { path: string; query?: Query; fallbackName: string }) {
  const { t } = useTranslation();
  const get = useMutation({
    mutationFn: async (locale: 'en' | 'ar') => {
      const { blob, filename } = await download(path, { ...query, locale, format: 'pdf', disposition: 'attachment' });
      saveBlob(blob, filename ?? `${fallbackName}-${locale}.pdf`);
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {(['en', 'ar'] as const).map((l) => (
        <Button key={l} variant="secondary" loading={get.isPending && get.variables === l} onClick={() => get.mutate(l)}>
          <FileText className="size-4" aria-hidden />{t(l === 'en' ? 'print.pdfEnglish' : 'print.pdfArabic')}
        </Button>
      ))}
      {get.isError && <span role="alert" className="text-sm text-red-700">{get.error instanceof ApiError ? get.error.message : t('common.error')}</span>}
    </div>
  );
}
