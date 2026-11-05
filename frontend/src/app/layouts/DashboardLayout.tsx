import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { Languages, LogOut, Menu, Moon, Sun, UserRound, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { setLocale } from '@/i18n';
import { isDark, setTheme, useTheme } from '@/lib/appearance';
import { NotificationsBell } from './NotificationsBell';
import { cn } from '@/lib/cn';
import type { Locale } from '@/lib/format';
import { canAny } from '@/lib/permissions';
import { Select } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/auth';
import { NAV } from '../nav';

export function DashboardLayout() {
  const { t, i18n } = useTranslation();
  const { me, permissions, logout, switchOffice } = useAuth();
  const [open, setOpen] = useState(false);
  const locale = i18n.language as Locale;
  useTheme(); // re-render when the theme changes
  const dark = isDark();

  const sidebar = (
    <nav aria-label="main" className="flex h-full flex-col gap-6 overflow-y-auto p-4">
      <div className="px-2 text-lg font-bold text-brand-700">{t('app.name')}</div>
      {NAV.map((group, gi) => {
        const items = group.items.filter((i) => i.permissions.length === 0 || canAny(permissions, ...i.permissions));
        if (items.length === 0) return null;
        return (
          <div key={gi} className="space-y-1">
            {group.titleKey && <div className="px-2 text-xs font-semibold uppercase tracking-wide text-slate-400">{t(group.titleKey)}</div>}
            {items.map(({ to, labelKey, icon: Icon }) => (
              <NavLink
                key={to} to={to} end={to === '/'} onClick={() => setOpen(false)}
                className={({ isActive }) => cn('flex items-center gap-3 rounded-md px-2 py-2 text-sm', isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100')}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(labelKey)}
              </NavLink>
            ))}
          </div>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      {/* Fixed sidebar on wide screens; it sits at the start edge, so it moves to the right in Arabic by itself. */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 border-e border-slate-200 bg-white lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t('common.menu')}>
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-64 bg-white shadow-xl">
            <button className="absolute end-2 top-2 rounded p-2 text-slate-500 hover:bg-slate-100" onClick={() => setOpen(false)} aria-label={t('common.back')}><X className="size-4" /></button>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <button className="rounded p-2 text-slate-600 hover:bg-slate-100 lg:hidden" onClick={() => setOpen(true)} aria-label={t('common.menu')}><Menu className="size-5" /></button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">
            {me && me.availableTenants.length > 1 ? (
              <Select aria-label={t('auth.office')} className="max-w-56" value={me.tenant.slug} onChange={(e) => void switchOffice(e.target.value)}>
                {me.availableTenants.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}
              </Select>
            ) : me?.tenant.name}
          </div>
          <NotificationsBell />
          <button
            className="flex items-center rounded px-2 py-1.5 text-slate-600 hover:bg-slate-100" aria-label={dark ? t('general.appearance.useLight') : t('general.appearance.useDark')}
            onClick={() => setTheme(dark ? 'light' : 'dark')}
          >
            {dark ? <Sun className="size-4" aria-hidden /> : <Moon className="size-4" aria-hidden />}
          </button>
          <button
            className="flex items-center gap-1 rounded px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')} aria-label={t('common.language')}
          >
            <Languages className="size-4" aria-hidden /><span className="hidden sm:inline">{locale === 'ar' ? 'English' : 'العربية'}</span>
          </button>
          <Link to="/account" className="flex items-center gap-1 rounded px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100" aria-label={t('account.title')}><UserRound className="size-4" aria-hidden /><span className="hidden sm:inline">{me?.user.firstName} {me?.user.lastName}</span></Link>
          <button className="flex items-center gap-1 rounded px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100" onClick={() => void logout()}>
            <LogOut className="rtl-flip size-4" aria-hidden /><span className="hidden sm:inline">{t('auth.signOut')}</span>
          </button>
        </header>
        <main className="flex-1 p-4 sm:p-6"><Outlet /></main>
      </div>
    </div>
  );
}
