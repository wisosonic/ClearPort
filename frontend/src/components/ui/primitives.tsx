import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

// NOTE: only logical Tailwind utilities here (ms-/me-/ps-/pe-/start-/end-/text-start). A test fails on physical left/right classes.

type Variant = 'primary' | 'secondary' | 'ghost';
export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }>(
  ({ className, variant = 'primary', loading, disabled, children, ...p }, ref) => (
    <button
      ref={ref} disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:cursor-not-allowed disabled:opacity-60',
        variant === 'primary' && 'bg-brand-600 text-white hover:bg-brand-700',
        variant === 'secondary' && 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50',
        variant === 'ghost' && 'text-slate-700 hover:bg-slate-100',
        className,
      )}
      {...p}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

const field = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-2 focus:outline-brand-500/30';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(field, className)} {...p} />);
Input.displayName = 'Input';
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => <select ref={ref} className={cn(field, 'pe-8', className)} {...p} />);
Select.displayName = 'Select';

export function Field({ label, hint, error, htmlFor, children }: { label: string; hint?: string; error?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">{label}</label>
      {children}
      {hint && !error && <p className="text-xs text-slate-500">{hint}</p>}
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('rounded-lg border border-slate-200 bg-white shadow-sm', className)} {...p} />;

type Tone = 'neutral' | 'blue' | 'green' | 'amber' | 'red';
const tones: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700', blue: 'bg-blue-100 text-blue-800', green: 'bg-green-100 text-green-800',
  amber: 'bg-amber-100 text-amber-800', red: 'bg-red-100 text-red-800',
};
export const Badge = ({ tone = 'neutral', className, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) => (
  <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)} {...p} />
);

export function Spinner({ label }: { label?: string }) {
  const { t } = useTranslation();
  return <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-slate-500"><Loader2 className="size-4 animate-spin" aria-hidden />{label ?? t('common.loading')}</div>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useTranslation();
  const message = error instanceof Error ? error.message : t('common.error');
  return (
    <div role="alert" className="flex flex-col items-center gap-3 p-8 text-center">
      <p className="text-sm text-red-700">{message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

export const EmptyState = ({ children }: { children?: ReactNode }) => {
  const { t } = useTranslation();
  return <div className="p-10 text-center text-sm text-slate-500">{children ?? t('common.none')}</div>;
};

/** Pagination whose arrows point the right way in both directions. */
export function Pagination({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <nav aria-label="pagination" className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>{t('common.results', { count: total })}</span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('common.previous')}><ChevronLeft className="rtl-flip size-4" aria-hidden /></Button>
        <span>{t('common.page', { page, pages })}</span>
        <Button variant="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('common.next')}><ChevronRight className="rtl-flip size-4" aria-hidden /></Button>
      </div>
    </nav>
  );
}

export const Th = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => <th scope="col" className={cn('px-4 py-2 text-start text-xs font-semibold uppercase tracking-wide text-slate-500', className)} {...p} />;
export const Td = ({ className, ...p }: HTMLAttributes<HTMLTableCellElement>) => <td className={cn('px-4 py-3 text-sm text-slate-800', className)} {...p} />;
