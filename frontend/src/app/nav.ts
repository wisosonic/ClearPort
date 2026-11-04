import { Banknote, BarChart3, BookOpen, CheckSquare, FileText, FolderOpen, LayoutDashboard, Receipt, Settings, Ship, Users, UserCog, type LucideIcon } from 'lucide-react';

export interface NavItem { to: string; labelKey: string; icon: LucideIcon; /** any one of these shows the item */ permissions: string[]; built: boolean }
export interface NavGroup { titleKey?: string; items: NavItem[] }

/** `permissions` only decide whether the link is shown; the API still enforces access. `built` marks screens that exist yet. */
export const NAV: NavGroup[] = [
  {
    items: [
      { to: '/', labelKey: 'nav.dashboard', icon: LayoutDashboard, permissions: [], built: true },
      { to: '/files', labelKey: 'nav.files', icon: FolderOpen, permissions: ['clearance_files.view'], built: true },
      { to: '/clients', labelKey: 'nav.clients', icon: Users, permissions: ['clients.view'], built: true },
      { to: '/shipments', labelKey: 'nav.shipments', icon: Ship, permissions: ['clearance_files.view'], built: false },
      { to: '/documents', labelKey: 'nav.documents', icon: FileText, permissions: ['documents.view'], built: false },
      { to: '/tasks', labelKey: 'nav.tasks', icon: CheckSquare, permissions: ['tasks.view'], built: true },
    ],
  },
  {
    titleKey: 'nav.financial',
    items: [
      { to: '/invoices', labelKey: 'nav.invoices', icon: Receipt, permissions: ['invoices.view'], built: true },
      { to: '/payments', labelKey: 'nav.payments', icon: Banknote, permissions: ['payments.view'], built: true },
      { to: '/expenses', labelKey: 'nav.expenses', icon: Receipt, permissions: ['expenses.view'], built: false },
      { to: '/accounting', labelKey: 'nav.accounting', icon: BookOpen, permissions: ['accounting.view'], built: true },
    ],
  },
  {
    titleKey: 'nav.management',
    items: [
      { to: '/reports', labelKey: 'nav.reports', icon: BarChart3, permissions: ['reports.view'], built: true },
      { to: '/users', labelKey: 'nav.users', icon: UserCog, permissions: ['users.manage', 'roles.manage'], built: true },
      { to: '/settings', labelKey: 'nav.settings', icon: Settings, permissions: ['settings.manage'], built: false },
    ],
  },
];
