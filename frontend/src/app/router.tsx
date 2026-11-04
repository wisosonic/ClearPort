import type { ReactNode } from 'react';
import { createBrowserRouter, createMemoryRouter, Navigate, useLocation, type RouteObject } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { canAny } from '@/lib/permissions';
import { Spinner } from '@/components/ui/primitives';
import { useAuth } from '@/features/auth/auth';
import { LoginPage } from '@/features/auth/pages/LoginPage';
import { AccountPage } from '@/features/account/AccountPage';
import { AccountingPage } from '@/features/accounting/pages/AccountingPage';
import { ClearanceFilesPage } from '@/features/clearance-files/pages/ClearanceFilesPage';
import { FileDetailPage } from '@/features/clearance-files/pages/FileDetailPage';
import { NewFilePage } from '@/features/clearance-files/pages/NewFilePage';
import { ClientDetailPage } from '@/features/clients/pages/ClientDetailPage';
import { NewClientPage } from '@/features/clients/pages/NewClientPage';
import { ClientsPage } from '@/features/clients/pages/ClientsPage';
import { InvoicesPage } from '@/features/finance/pages/InvoicesPage';
import { PaymentsPage } from '@/features/finance/pages/PaymentsPage';
import { ReportsPage } from '@/features/reports/pages/ReportsPage';
import { UsersPage } from '@/features/users/pages/UsersPage';
import { SettingsPage } from '@/features/settings/pages/SettingsPage';
import { DocumentsPage } from '@/features/office-lists/pages/DocumentsPage';
import { ExpensesPage } from '@/features/office-lists/pages/ExpensesPage';
import { ShipmentsPage } from '@/features/office-lists/pages/ShipmentsPage';
import { TasksPage } from '@/features/tasks/TasksPage';
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

const comingSoon = NAV.flatMap((g) => g.items).filter((i) => !i.built).map((i): RouteObject => ({
  path: i.to.slice(1), element: guard(i.permissions, <Message k="common.comingSoon" />),
}));

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/', element: <RequireAuth><DashboardLayout /></RequireAuth>,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'files', element: guard(['clearance_files.view'], <ClearanceFilesPage />) },
      { path: 'files/new', element: guard(['clearance_files.create'], <NewFilePage />) },
      { path: 'files/:id', element: guard(['clearance_files.view'], <FileDetailPage />) },
      { path: 'clients', element: guard(['clients.view'], <ClientsPage />) },
      { path: 'clients/new', element: guard(['clients.manage'], <NewClientPage />) },
      { path: 'clients/:id', element: guard(['clients.view'], <ClientDetailPage />) },
      { path: 'tasks', element: guard(['tasks.view'], <TasksPage />) },
      { path: 'settings', element: guard(['settings.manage', 'workflows.manage'], <SettingsPage />) },
      { path: 'users', element: guard(['users.manage', 'roles.manage'], <UsersPage />) },
      { path: 'accounting', element: guard(['accounting.view'], <AccountingPage />) },
      { path: 'reports', element: guard(['reports.view'], <ReportsPage />) },
      { path: 'account', element: <AccountPage /> },
      { path: 'shipments', element: guard(['clearance_files.view'], <ShipmentsPage />) },
      { path: 'documents', element: guard(['documents.view'], <DocumentsPage />) },
      { path: 'expenses', element: guard(['expenses.view'], <ExpensesPage />) },
      { path: 'invoices', element: guard(['invoices.view'], <InvoicesPage />) },
      { path: 'payments', element: guard(['payments.view'], <PaymentsPage />) },
      ...comingSoon,
      { path: '*', element: <Message k="common.notFound" /> },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);
export const createTestRouter = (initial: string) => createMemoryRouter(routes, { initialEntries: [initial] });
