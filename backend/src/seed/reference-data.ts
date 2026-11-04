import type { PrismaClient } from '../generated/prisma/client';

// ───────────────────────── Permissions and system roles ─────────────────────────

export const PERMISSIONS: Record<string, string> = {
  'clients.view': 'View clients and business parties',
  'clients.manage': 'Create and edit clients and business parties',
  'clearance_files.view': 'View clearance files',
  'clearance_files.create': 'Create clearance files',
  'clearance_files.update': 'Edit clearance files, shipments, containers and goods',
  'clearance_files.assign': 'Assign clearance files to employees',
  'clearance_files.transition': 'Move a file between workflow stages',
  'clearance_files.close': 'Close or reopen a clearance file',
  'clearance_files.approve': 'Approve workflow transitions that require approval',
  'documents.view': 'View and download documents',
  'documents.upload': 'Upload documents and new versions',
  'documents.review': 'Review, approve or reject documents',
  'documents.delete': 'Void documents',
  'tasks.view': 'View tasks',
  'tasks.manage': 'Create, edit and complete tasks',
  'workflows.manage': 'Configure workflow templates, stages and transitions',
  'expenses.view': 'View expenses',
  'expenses.create': 'Record expenses',
  'expenses.approve': 'Approve expenses',
  'invoices.view': 'View invoices',
  'invoices.create': 'Create draft invoices',
  'invoices.issue': 'Issue and cancel invoices',
  'payments.view': 'View payments',
  'payments.create': 'Record and allocate payments',
  'accounting.view': 'View chart of accounts and journal entries',
  'accounting.post': 'Post and reverse journal entries',
  'reports.view': 'View dashboards and reports',
  'reports.export': 'Export reports',
  'users.manage': 'Manage users and role assignments',
  'roles.manage': 'Manage roles and permissions',
  'settings.manage': 'Manage office settings, branches and reference data',
  'audit.view': 'View audit logs',
};

const ALL = Object.keys(PERMISSIONS);
const VIEW_ONLY = ALL.filter((p) => p.endsWith('.view'));

export const SYSTEM_ROLES: { code: string; name: string; description: string; permissions: string[] }[] = [
  { code: 'OWNER', name: 'Owner', description: 'Full tenant access', permissions: ALL },
  {
    code: 'ADMIN',
    name: 'Admin',
    description: 'Office configuration and user management',
    permissions: ALL.filter((p) => !p.startsWith('accounting.post')),
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    description: 'Operational and financial management',
    permissions: ALL.filter((p) => !['users.manage', 'roles.manage', 'settings.manage'].includes(p)),
  },
  {
    code: 'CLEARANCE_OFFICER',
    name: 'Clearance Officer',
    description: 'Clearance files, shipments, documents and tasks',
    permissions: [
      'clients.view', 'clearance_files.view', 'clearance_files.create', 'clearance_files.update',
      'clearance_files.transition', 'documents.view', 'documents.upload', 'tasks.view', 'tasks.manage',
      'expenses.view', 'expenses.create', 'invoices.view', 'payments.view',
    ],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    description: 'Invoices, expenses, payments and accounting',
    permissions: [
      'clients.view', 'clearance_files.view', 'documents.view', 'expenses.view', 'expenses.create',
      'expenses.approve', 'invoices.view', 'invoices.create', 'invoices.issue', 'payments.view',
      'payments.create', 'accounting.view', 'accounting.post', 'reports.view', 'reports.export',
    ],
  },
  { code: 'VIEWER', name: 'Viewer', description: 'Read-only access', permissions: VIEW_ONLY },
];

// ───────────────────────────── Static reference data ─────────────────────────────

export const CURRENCIES = [
  { code: 'USD', name: 'US Dollar', symbol: '$', decimalPlaces: 2 },
  { code: 'LBP', name: 'Lebanese Pound', symbol: 'ل.ل', decimalPlaces: 0 },
  { code: 'EUR', name: 'Euro', symbol: '€', decimalPlaces: 2 },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', decimalPlaces: 2 },
  { code: 'AED', name: 'UAE Dirham', symbol: 'د.إ', decimalPlaces: 2 },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'ر.س', decimalPlaces: 2 },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺', decimalPlaces: 2 },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', decimalPlaces: 2 },
];

export const COUNTRIES = [
  { code: 'LB', nameEn: 'Lebanon', nameAr: 'لبنان' },
  { code: 'SY', nameEn: 'Syria', nameAr: 'سوريا' },
  { code: 'JO', nameEn: 'Jordan', nameAr: 'الأردن' },
  { code: 'EG', nameEn: 'Egypt', nameAr: 'مصر' },
  { code: 'TR', nameEn: 'Turkey', nameAr: 'تركيا' },
  { code: 'AE', nameEn: 'United Arab Emirates', nameAr: 'الإمارات العربية المتحدة' },
  { code: 'SA', nameEn: 'Saudi Arabia', nameAr: 'المملكة العربية السعودية' },
  { code: 'CY', nameEn: 'Cyprus', nameAr: 'قبرص' },
  { code: 'IT', nameEn: 'Italy', nameAr: 'إيطاليا' },
  { code: 'FR', nameEn: 'France', nameAr: 'فرنسا' },
  { code: 'DE', nameEn: 'Germany', nameAr: 'ألمانيا' },
  { code: 'ES', nameEn: 'Spain', nameAr: 'إسبانيا' },
  { code: 'GR', nameEn: 'Greece', nameAr: 'اليونان' },
  { code: 'GB', nameEn: 'United Kingdom', nameAr: 'المملكة المتحدة' },
  { code: 'US', nameEn: 'United States', nameAr: 'الولايات المتحدة' },
  { code: 'CN', nameEn: 'China', nameAr: 'الصين' },
  { code: 'IN', nameEn: 'India', nameAr: 'الهند' },
  { code: 'BR', nameEn: 'Brazil', nameAr: 'البرازيل' },
  { code: 'UA', nameEn: 'Ukraine', nameAr: 'أوكرانيا' },
  { code: 'RU', nameEn: 'Russia', nameAr: 'روسيا' },
];

export const UNITS_OF_MEASURE = [
  { code: 'PCS', nameEn: 'Pieces', nameAr: 'قطعة' },
  { code: 'KG', nameEn: 'Kilogram', nameAr: 'كيلوغرام' },
  { code: 'TON', nameEn: 'Metric ton', nameAr: 'طن' },
  { code: 'LTR', nameEn: 'Litre', nameAr: 'لتر' },
  { code: 'M', nameEn: 'Metre', nameAr: 'متر' },
  { code: 'M2', nameEn: 'Square metre', nameAr: 'متر مربع' },
  { code: 'M3', nameEn: 'Cubic metre', nameAr: 'متر مكعب' },
  { code: 'CTN', nameEn: 'Carton', nameAr: 'كرتونة' },
  { code: 'PLT', nameEn: 'Pallet', nameAr: 'طبلية' },
  { code: 'SET', nameEn: 'Set', nameAr: 'طقم' },
];

export const PAYMENT_METHODS = [
  { code: 'CASH', nameEn: 'Cash', nameAr: 'نقداً' },
  { code: 'BANK_TRANSFER', nameEn: 'Bank transfer', nameAr: 'تحويل مصرفي' },
  { code: 'CHEQUE', nameEn: 'Cheque', nameAr: 'شيك' },
  { code: 'CARD', nameEn: 'Card', nameAr: 'بطاقة' },
  { code: 'OTHER', nameEn: 'Other', nameAr: 'أخرى' },
];

export const DOCUMENT_TYPES = [
  { code: 'COMMERCIAL_INVOICE', nameEn: 'Commercial Invoice', nameAr: 'فاتورة تجارية' },
  { code: 'PACKING_LIST', nameEn: 'Packing List', nameAr: 'قائمة التعبئة' },
  { code: 'BILL_OF_LADING', nameEn: 'Bill of Lading', nameAr: 'بوليصة الشحن' },
  { code: 'CERTIFICATE_OF_ORIGIN', nameEn: 'Certificate of Origin', nameAr: 'شهادة المنشأ' },
  { code: 'DELIVERY_ORDER', nameEn: 'Delivery Order', nameAr: 'إذن التسليم' },
  { code: 'CUSTOMS_DECLARATION', nameEn: 'Customs Declaration', nameAr: 'البيان الجمركي' },
  { code: 'IMPORT_PERMIT', nameEn: 'Import Permit', nameAr: 'إجازة استيراد' },
  { code: 'PAYMENT_PROOF', nameEn: 'Payment Proof', nameAr: 'إثبات الدفع' },
  { code: 'INSPECTION_REPORT', nameEn: 'Inspection Report', nameAr: 'تقرير الكشف' },
  { code: 'OTHER', nameEn: 'Other', nameAr: 'أخرى' },
];

// UN/LOCODE. Lebanese ports plus common origin ports. Verify and extend with the pilot offices.
export const PORTS = [
  { code: 'LBBEY', name: 'Beirut', countryCode: 'LB', portType: 'SEA' },
  { code: 'LBTRI', name: 'Tripoli', countryCode: 'LB', portType: 'SEA' },
  { code: 'LBSAI', name: 'Saida (Sidon)', countryCode: 'LB', portType: 'SEA' },
  { code: 'LBSOU', name: 'Tyre (Sour)', countryCode: 'LB', portType: 'SEA' },
  { code: 'LBJIY', name: 'Jiyeh', countryCode: 'LB', portType: 'SEA' },
  { code: 'LBBEA', name: 'Beirut Rafic Hariri Airport', countryCode: 'LB', portType: 'AIR' },
  { code: 'LBMSN', name: 'Masnaa Border Crossing', countryCode: 'LB', portType: 'LAND' },
  { code: 'CNSHA', name: 'Shanghai', countryCode: 'CN', portType: 'SEA' },
  { code: 'CNNGB', name: 'Ningbo', countryCode: 'CN', portType: 'SEA' },
  { code: 'CNQZH', name: 'Qingdao', countryCode: 'CN', portType: 'SEA' },
  { code: 'TRMER', name: 'Mersin', countryCode: 'TR', portType: 'SEA' },
  { code: 'TRIST', name: 'Istanbul', countryCode: 'TR', portType: 'SEA' },
  { code: 'AEJEA', name: 'Jebel Ali', countryCode: 'AE', portType: 'SEA' },
  { code: 'EGALY', name: 'Alexandria', countryCode: 'EG', portType: 'SEA' },
  { code: 'EGPSD', name: 'Port Said', countryCode: 'EG', portType: 'SEA' },
  { code: 'ITGOA', name: 'Genoa', countryCode: 'IT', portType: 'SEA' },
  { code: 'FRMRS', name: 'Marseille', countryCode: 'FR', portType: 'SEA' },
  { code: 'ESVLC', name: 'Valencia', countryCode: 'ES', portType: 'SEA' },
  { code: 'GRPIR', name: 'Piraeus', countryCode: 'GR', portType: 'SEA' },
  { code: 'CYLMS', name: 'Limassol', countryCode: 'CY', portType: 'SEA' },
  { code: 'DEHAM', name: 'Hamburg', countryCode: 'DE', portType: 'SEA' },
  { code: 'NLRTM', name: 'Rotterdam', countryCode: 'NL', portType: 'SEA' },
  { code: 'INNSA', name: 'Nhava Sheva (Mumbai)', countryCode: 'IN', portType: 'SEA' },
] as const;

/** Idempotent. Seeds all global (non-tenant) reference data. */
export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await prisma.permission.upsert({ where: { code }, update: { description }, create: { code, description } });
  }
  const permissionIds = new Map(
    (await prisma.permission.findMany()).map((p) => [p.code, p.id] as const),
  );

  for (const role of SYSTEM_ROLES) {
    // (tenantId, code) with NULL tenant cannot be used in an upsert `where`; look it up manually.
    const existing = await prisma.role.findFirst({ where: { tenantId: null, code: role.code } });
    const saved =
      existing ??
      (await prisma.role.create({
        data: { tenantId: null, code: role.code, name: role.name, description: role.description, isSystem: true },
      }));
    await prisma.rolePermission.deleteMany({ where: { roleId: saved.id } });
    await prisma.rolePermission.createMany({
      data: role.permissions.map((p) => ({ roleId: saved.id, permissionId: permissionIds.get(p)! })),
    });
  }

  for (const c of CURRENCIES) await prisma.currency.upsert({ where: { code: c.code }, update: c, create: c });
  for (const c of COUNTRIES) await prisma.country.upsert({ where: { code: c.code }, update: c, create: c });
  for (const u of UNITS_OF_MEASURE) await prisma.unitOfMeasure.upsert({ where: { code: u.code }, update: u, create: u });
  for (const m of PAYMENT_METHODS) await prisma.paymentMethod.upsert({ where: { code: m.code }, update: m, create: m });
  for (const p of PORTS) await prisma.port.upsert({ where: { code: p.code }, update: p, create: p });

  for (const t of DOCUMENT_TYPES) {
    const existing = await prisma.documentType.findFirst({ where: { tenantId: null, code: t.code } });
    if (existing) await prisma.documentType.update({ where: { id: existing.id }, data: t });
    else await prisma.documentType.create({ data: { tenantId: null, ...t } });
  }
}
