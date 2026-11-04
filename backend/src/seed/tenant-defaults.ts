import type { PrismaClient } from '../generated/prisma/client';

/** Anything with the model delegates — the root client or an interactive-transaction client. */
type Db = Pick<
  PrismaClient,
  | 'workflowTemplate' | 'workflowStage' | 'workflowTransition' | 'documentType'
  | 'documentRequirement' | 'financialCategory' | 'chartOfAccount' | 'cashAccount'
>;

// ───────────── Default workflows (SEED DEFAULTS, not legal requirements — spec 5.3) ─────────────

interface StageDef { code: string; nameEn: string; nameAr: string; isTerminal?: boolean }

const IMPORT_STAGES: StageDef[] = [
  { code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد' },
  { code: 'DOCUMENT_COLLECTION', nameEn: 'Document collection', nameAr: 'جمع المستندات' },
  { code: 'PRE_CLEARANCE', nameEn: 'Pre-clearance preparation', nameAr: 'التحضير للتخليص' },
  { code: 'DECLARATION_SUBMITTED', nameEn: 'Declaration submitted', nameAr: 'تقديم البيان الجمركي' },
  { code: 'ASSESSMENT_INSPECTION', nameEn: 'Customs assessment / inspection', nameAr: 'التدقيق والكشف الجمركي' },
  { code: 'DUTIES_CHARGES', nameEn: 'Duties and charges', nameAr: 'الرسوم والمصاريف' },
  { code: 'CUSTOMS_RELEASE', nameEn: 'Customs release', nameAr: 'الإفراج الجمركي' },
  { code: 'DELIVERY_CLOSURE', nameEn: 'Delivery and file closure', nameAr: 'التسليم وإقفال الملف', isTerminal: true },
];

const EXPORT_STAGES: StageDef[] = [
  { code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد' },
  { code: 'DOCUMENT_COLLECTION', nameEn: 'Document collection', nameAr: 'جمع المستندات' },
  { code: 'DECLARATION_SUBMITTED', nameEn: 'Declaration submitted', nameAr: 'تقديم البيان الجمركي' },
  { code: 'CUSTOMS_RELEASE', nameEn: 'Customs release', nameAr: 'الإفراج الجمركي' },
  { code: 'DELIVERY_CLOSURE', nameEn: 'Shipment dispatched and file closure', nameAr: 'الشحن وإقفال الملف', isTerminal: true },
];

const OTHER_STAGES: StageDef[] = [
  { code: 'NEW_FILE', nameEn: 'New file', nameAr: 'ملف جديد' },
  { code: 'IN_PROGRESS', nameEn: 'In progress', nameAr: 'قيد التنفيذ' },
  { code: 'DONE', nameEn: 'Completed and closed', nameAr: 'مكتمل ومقفل', isTerminal: true },
];

// Stages whose entry needs the required-document check (documents "required before" them).
const DOCUMENT_GATED_STAGES = new Set(['DECLARATION_SUBMITTED']);
const CLOSING_STAGES = new Set(['DELIVERY_CLOSURE', 'DONE']);

async function createWorkflow(
  db: Db,
  tenantId: string,
  def: { name: string; fileType: 'IMPORT' | 'EXPORT' | 'OTHER'; description: string; stages: StageDef[] },
) {
  const template = await db.workflowTemplate.create({
    data: { tenantId, name: def.name, fileType: def.fileType, description: def.description },
  });
  const stages = [];
  for (const [i, s] of def.stages.entries()) {
    stages.push(
      await db.workflowStage.create({
        data: {
          tenantId, workflowTemplateId: template.id, code: s.code, nameEn: s.nameEn, nameAr: s.nameAr,
          sequence: i + 1, isTerminal: s.isTerminal ?? false,
        },
      }),
    );
  }
  for (let i = 0; i < stages.length - 1; i++) {
    const to = stages[i + 1];
    // Forward transition
    await db.workflowTransition.create({
      data: {
        tenantId, workflowTemplateId: template.id, fromStageId: stages[i].id, toStageId: to.id,
        requiredPermission: CLOSING_STAGES.has(to.code) ? 'clearance_files.close' : 'clearance_files.transition',
        requiresDocumentCheck: DOCUMENT_GATED_STAGES.has(to.code),
        requiresApproval: false,
        requiresReason: false,
        requiredTaskCheck: CLOSING_STAGES.has(to.code),
      },
    });
    // Backward transition (needs a reason). Not allowed out of the terminal stage — use reopen.
    if (!stages[i + 1].isTerminal) {
      await db.workflowTransition.create({
        data: {
          tenantId, workflowTemplateId: template.id, fromStageId: to.id, toStageId: stages[i].id,
          requiredPermission: 'clearance_files.transition', requiresReason: true,
        },
      });
    }
  }
  return { template, stages };
}

/**
 * Creates the per-tenant defaults: workflow templates, document requirements, financial
 * categories, chart of accounts and cash accounts. Call inside the tenant-creation
 * transaction. Everything here is editable by the office afterwards.
 */
export async function provisionTenantDefaults(db: Db, tenantId: string): Promise<void> {
  // Workflows
  const imp = await createWorkflow(db, tenantId, {
    name: 'Standard import clearance', fileType: 'IMPORT',
    description: 'Default import workflow (seed default, configurable)', stages: IMPORT_STAGES,
  });
  const exp = await createWorkflow(db, tenantId, {
    name: 'Standard export clearance', fileType: 'EXPORT',
    description: 'Default export workflow (seed default, configurable)', stages: EXPORT_STAGES,
  });
  await createWorkflow(db, tenantId, {
    name: 'General file', fileType: 'OTHER',
    description: 'Generic workflow for other operations', stages: OTHER_STAGES,
  });

  // Document requirements (editable; a starting point, not a legal list)
  const types = new Map(
    (await db.documentType.findMany({ where: { tenantId: null } })).map((t) => [t.code, t.id] as const),
  );
  const gate = (stages: { id: string; code: string }[]) => stages.find((s) => s.code === 'DECLARATION_SUBMITTED')!.id;
  const req = (
    fileType: 'IMPORT' | 'EXPORT', code: string, required: boolean, stageId: string | null,
  ) =>
    db.documentRequirement.create({
      data: {
        tenantId, fileType, documentTypeId: types.get(code)!, isRequired: required,
        isRequiredBeforeStageId: stageId,
      },
    });
  for (const code of ['COMMERCIAL_INVOICE', 'PACKING_LIST', 'BILL_OF_LADING']) await req('IMPORT', code, true, gate(imp.stages));
  for (const code of ['CERTIFICATE_OF_ORIGIN', 'DELIVERY_ORDER', 'IMPORT_PERMIT']) await req('IMPORT', code, false, null);
  for (const code of ['COMMERCIAL_INVOICE', 'PACKING_LIST']) await req('EXPORT', code, true, gate(exp.stages));

  // Financial categories (cost treatment drives profitability — spec 6.2 / 6.5)
  const categories = [
    { name: 'Customs duties and taxes', categoryType: 'CUSTOMS_DUTY_TAX', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
    { name: 'Port fees', categoryType: 'PORT_FEE', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
    { name: 'Shipping fees', categoryType: 'SHIPPING_FEE', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
    { name: 'Transportation', categoryType: 'TRANSPORTATION', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
    { name: 'Clearance service fees', categoryType: 'SERVICE_FEE', costTreatment: 'OFFICE_REVENUE', isBillableToClient: true, isTaxable: true },
    { name: 'Inspection expenses', categoryType: 'INSPECTION', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
    { name: 'Storage charges', categoryType: 'STORAGE', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
    { name: 'Office expenses (non-billable)', categoryType: 'OTHER', costTreatment: 'OFFICE_EXPENSE', isBillableToClient: false },
    { name: 'Other expenses', categoryType: 'OTHER', costTreatment: 'PASS_THROUGH', isBillableToClient: true },
  ] as const;
  for (const c of categories) await db.financialCategory.create({ data: { tenantId, ...c } });

  // Chart of accounts — simplified foundation for double-entry (spec 6.6)
  const coa = [
    ['1000', 'Cash and bank', 'ASSET', null],
    ['1010', 'Cashbox USD', 'ASSET', '1000'],
    ['1020', 'Cashbox LBP', 'ASSET', '1000'],
    ['1030', 'Bank account', 'ASSET', '1000'],
    ['1200', 'Accounts receivable', 'ASSET', null],
    ['1300', 'Client disbursements receivable', 'ASSET', null],
    ['2100', 'Client advances (liability)', 'LIABILITY', null],
    ['2200', 'Accounts payable', 'LIABILITY', null],
    ['2300', 'Taxes payable', 'LIABILITY', null],
    ['3000', 'Owner equity', 'EQUITY', null],
    ['4100', 'Clearance service fee revenue', 'REVENUE', null],
    ['4200', 'Other revenue', 'REVENUE', null],
    ['4300', 'Foreign exchange gain / loss', 'REVENUE', null],
    ['5100', 'Office operating expenses', 'EXPENSE', null],
    ['5200', 'Non-recoverable client costs', 'EXPENSE', null],
  ] as const;
  const accountIds = new Map<string, string>();
  for (const [accountCode, name, accountType, parentCode] of coa) {
    const row = await db.chartOfAccount.create({
      data: { tenantId, accountCode, name, accountType, parentId: parentCode ? accountIds.get(parentCode)! : null },
    });
    accountIds.set(accountCode, row.id);
  }

  // Cash accounts linked to ledger accounts
  await db.cashAccount.create({
    data: { tenantId, name: 'USD cashbox', accountType: 'CASHBOX', currencyCode: 'USD', ledgerAccountId: accountIds.get('1010')! },
  });
  await db.cashAccount.create({
    data: { tenantId, name: 'LBP cashbox', accountType: 'CASHBOX', currencyCode: 'LBP', ledgerAccountId: accountIds.get('1020')! },
  });
}
