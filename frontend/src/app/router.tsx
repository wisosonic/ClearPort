import type { ComponentType, ReactNode } from 'react';
import { createBrowserRouter, createMemoryRouter, Navigate, useLocation, type RouteObject } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { canAny } from '@/lib/permissions';
import { Spinner } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/auth';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { DashboardPage } from '@/features/dashboard/pages/DashboardPage';
import { DashboardLayout } from './layouts/DashboardLayout';
import { NAV } from './nav';

/** Sends anonymous visitors to the login page (remembering where they were going). */
function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <Spinner />;
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <>{children}</>;
}

/** Hides a screen the user has no permission for. The API refuses the data anyway; this is the friendly version. */
function RequirePermission({ any, children }: { any: string[]; children: ReactNode }) {
  const { permissions } = useAuth();
  const { t } = useTranslation();
  if (any.length > 0 && !canAny(permissions, ...any)) return <p role="alert" className="p-8 text-center text-slate-600">{t('common.forbidden')}</p>;
  return <>{children}</>;
}

const Message = ({ k }: { k: string }) => { const { t } = useTranslation(); return <p className="p-8 text-center text-slate-500">{t(k)}</p>; };

const guard = (any: string[], el: ReactNode) => <RequirePermission any={any}>{el}</RequirePermission>;

/** A screen loaded on first visit, so the first page the user sees downloads less code. */
const lazyPage = (any: string[], load: () => Promise<ComponentType>): Pick<RouteObject, 'lazy'> => ({
  lazy: async () => { const Page = await load(); return { element: guard(any, <Page />) }; },
});

const comingSoon = NAV.flatMap((g) => g.items).filter((i) => !i.built).map((i): RouteObject => ({
  path: i.to.slice(1), element: guard(i.permissions, <Message k="common.comingSoon" />),
}));

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/', element: <RequireAuth><DashboardLayout /></RequireAuth>,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'files', ...lazyPage(['clearance_files.view'], () => import('@/features/clearance-files/pages/ClearanceFilesPage').then((x) => x.ClearanceFilesPage)) },
      { path: 'files/new', ...lazyPage(['clearance_files.create'], () => import('@/features/clearance-files/pages/NewFilePage').then((x) => x.NewFilePage)) },
      { path: 'files/:id', ...lazyPage(['clearance_files.view'], () => import('@/features/clearance-files/pages/FileDetailPage').then((x) => x.FileDetailPage)) },
      { path: 'clients', ...lazyPage(['clients.view'], () => import('@/features/clients/pages/ClientsPage').then((x) => x.ClientsPage)) },
      { path: 'clients/new', ...lazyPage(['clients.manage'], () => import('@/features/clients/pages/NewClientPage').then((x) => x.NewClientPage)) },
      { path: 'clients/:id', ...lazyPage(['clients.view'], () => import('@/features/clients/pages/ClientDetailPage').then((x) => x.ClientDetailPage)) },
      { path: 'parties', ...lazyPage(['clients.view'], () => import('@/features/parties/PartiesPage').then((x) => x.PartiesPage)) },
      { path: 'tasks', ...lazyPage(['tasks.view'], () => import('@/features/tasks/TasksPage').then((x) => x.TasksPage)) },
      { path: 'settings', ...lazyPage(['settings.manage', 'workflows.manage'], () => import('@/features/settings/pages/SettingsPage').then((x) => x.SettingsPage)) },
      { path: 'users', ...lazyPage(['users.manage', 'roles.manage'], () => import('@/features/users/pages/UsersPage').then((x) => x.UsersPage)) },
      { path: 'accounting', ...lazyPage(['accounting.view'], () => import('@/features/accounting/pages/AccountingPage').then((x) => x.AccountingPage)) },
      { path: 'reports', ...lazyPage(['reports.view'], () => import('@/features/reports/pages/ReportsPage').then((x) => x.ReportsPage)) },
      { path: 'audit', ...lazyPage(['audit.view'], () => import('@/features/audit/AuditPage').then((x) => x.AuditPage)) },
      { path: 'account', ...lazyPage([], () => import('@/features/account/AccountPage').then((m) => m.AccountPage)) },
      { path: 'shipments', ...lazyPage(['clearance_files.view'], () => import('@/features/office-lists/pages/ShipmentsPage').then((x) => x.ShipmentsPage)) },
      { path: 'documents', ...lazyPage(['documents.view'], () => import('@/features/office-lists/pages/DocumentsPage').then((x) => x.DocumentsPage)) },
      { path: 'expenses', ...lazyPage(['expenses.view'], () => import('@/features/office-lists/pages/ExpensesPage').then((x) => x.ExpensesPage)) },
      { path: 'invoices', ...lazyPage(['invoices.view'], () => import('@/features/finance/pages/InvoicesPage').then((x) => x.InvoicesPage)) },
      { path: 'payments', ...lazyPage(['payments.view'], () => import('@/features/finance/pages/PaymentsPage').then((x) => x.PaymentsPage)) },
      ...comingSoon,
      { path: '*', element: <Message k="common.notFound" /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
export const createTestRouter = (initial: string) => createMemoryRouter(routes, { initialEntries: [initial] });
