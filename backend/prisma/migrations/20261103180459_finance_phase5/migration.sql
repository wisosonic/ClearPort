-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_expenses" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT,
    "categoryId" TEXT NOT NULL,
    "vendorId" TEXT,
    "description" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "exchangeRate" TEXT NOT NULL,
    "rateConvention" TEXT NOT NULL DEFAULT 'BASE_PER_FOREIGN',
    "rateSource" TEXT,
    "baseAmount" TEXT NOT NULL,
    "expenseDate" DATETIME NOT NULL,
    "paidBy" TEXT NOT NULL DEFAULT 'OFFICE',
    "paymentStatus" TEXT NOT NULL DEFAULT 'UNPAID',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "recordedBy" TEXT NOT NULL,
    "approvedBy" TEXT,
    "approvedAt" DATETIME,
    "cashAccountId" TEXT,
    "paidAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "expenses_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_cashAccountId_fkey" FOREIGN KEY ("tenantId", "cashAccountId") REFERENCES "cash_accounts" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "financial_categories" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_tenantId_vendorId_fkey" FOREIGN KEY ("tenantId", "vendorId") REFERENCES "business_parties" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "expenses_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_expenses" ("amount", "approvedAt", "approvedBy", "baseAmount", "categoryId", "clearanceFileId", "createdAt", "currencyCode", "description", "exchangeRate", "expenseDate", "id", "paidBy", "paymentStatus", "rateConvention", "rateSource", "recordedBy", "status", "tenantId", "updatedAt", "vendorId") SELECT "amount", "approvedAt", "approvedBy", "baseAmount", "categoryId", "clearanceFileId", "createdAt", "currencyCode", "description", "exchangeRate", "expenseDate", "id", "paidBy", "paymentStatus", "rateConvention", "rateSource", "recordedBy", "status", "tenantId", "updatedAt", "vendorId" FROM "expenses";
DROP TABLE "expenses";
ALTER TABLE "new_expenses" RENAME TO "expenses";
CREATE INDEX "expenses_tenantId_clearanceFileId_idx" ON "expenses"("tenantId", "clearanceFileId");
CREATE UNIQUE INDEX "expenses_tenantId_id_key" ON "expenses"("tenantId", "id");
CREATE TABLE "new_financial_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "categoryType" TEXT NOT NULL,
    "costTreatment" TEXT NOT NULL DEFAULT 'PASS_THROUGH',
    "isBillableToClient" BOOLEAN NOT NULL DEFAULT true,
    "isTaxable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "financial_categories_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_financial_categories" ("categoryType", "costTreatment", "id", "isActive", "isBillableToClient", "name", "tenantId") SELECT "categoryType", "costTreatment", "id", "isActive", "isBillableToClient", "name", "tenantId" FROM "financial_categories";
DROP TABLE "financial_categories";
ALTER TABLE "new_financial_categories" RENAME TO "financial_categories";
CREATE UNIQUE INDEX "financial_categories_tenantId_id_key" ON "financial_categories"("tenantId", "id");
CREATE UNIQUE INDEX "financial_categories_tenantId_name_key" ON "financial_categories"("tenantId", "name");
CREATE TABLE "new_invoice_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "categoryId" TEXT,
    "quantity" TEXT NOT NULL,
    "unitPrice" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "taxRate" TEXT NOT NULL DEFAULT '0',
    "taxAmount" TEXT NOT NULL DEFAULT '0',
    "expenseId" TEXT,
    CONSTRAINT "invoice_items_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_items_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_items_tenantId_categoryId_fkey" FOREIGN KEY ("tenantId", "categoryId") REFERENCES "financial_categories" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoice_items_tenantId_expenseId_fkey" FOREIGN KEY ("tenantId", "expenseId") REFERENCES "expenses" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_invoice_items" ("amount", "categoryId", "description", "id", "invoiceId", "quantity", "tenantId", "unitPrice") SELECT "amount", "categoryId", "description", "id", "invoiceId", "quantity", "tenantId", "unitPrice" FROM "invoice_items";
DROP TABLE "invoice_items";
ALTER TABLE "new_invoice_items" RENAME TO "invoice_items";
CREATE INDEX "invoice_items_tenantId_invoiceId_idx" ON "invoice_items"("tenantId", "invoiceId");
CREATE TABLE "new_invoices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "clearanceFileId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL DEFAULT 'STANDARD',
    "issueDate" DATETIME,
    "dueDate" DATETIME,
    "currencyCode" TEXT NOT NULL,
    "subtotal" TEXT NOT NULL,
    "discount" TEXT NOT NULL DEFAULT '0',
    "taxAmount" TEXT NOT NULL DEFAULT '0',
    "totalAmount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "issuedAt" DATETIME,
    "cancelledAt" DATETIME,
    "cancelReason" TEXT,
    "exchangeRate" TEXT,
    "rateConvention" TEXT NOT NULL DEFAULT 'BASE_PER_FOREIGN',
    "rateSource" TEXT,
    "baseTotalAmount" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "invoices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_tenantId_clearanceFileId_fkey" FOREIGN KEY ("tenantId", "clearanceFileId") REFERENCES "clearance_files" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "clients" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "invoices_currencyCode_fkey" FOREIGN KEY ("currencyCode") REFERENCES "currencies" ("code") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_invoices" ("cancelReason", "cancelledAt", "clearanceFileId", "clientId", "createdAt", "createdBy", "currencyCode", "discount", "dueDate", "id", "invoiceNumber", "invoiceType", "issueDate", "issuedAt", "status", "subtotal", "taxAmount", "tenantId", "totalAmount", "updatedAt") SELECT "cancelReason", "cancelledAt", "clearanceFileId", "clientId", "createdAt", "createdBy", "currencyCode", "discount", "dueDate", "id", "invoiceNumber", "invoiceType", "issueDate", "issuedAt", "status", "subtotal", "taxAmount", "tenantId", "totalAmount", "updatedAt" FROM "invoices";
DROP TABLE "invoices";
ALTER TABLE "new_invoices" RENAME TO "invoices";
CREATE INDEX "invoices_tenantId_clientId_idx" ON "invoices"("tenantId", "clientId");
CREATE INDEX "invoices_tenantId_clearanceFileId_idx" ON "invoices"("tenantId", "clearanceFileId");
CREATE UNIQUE INDEX "invoices_tenantId_invoiceNumber_key" ON "invoices"("tenantId", "invoiceNumber");
CREATE UNIQUE INDEX "invoices_tenantId_id_key" ON "invoices"("tenantId", "id");
CREATE TABLE "new_payment_allocations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tenantId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "allocatedAmount" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "paymentAmount" TEXT NOT NULL DEFAULT '0',
    "paymentBaseAmount" TEXT NOT NULL DEFAULT '0',
    "invoiceBaseAmount" TEXT NOT NULL DEFAULT '0',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" DATETIME,
    "reversalReason" TEXT,
    CONSTRAINT "payment_allocations_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_allocations_tenantId_paymentId_fkey" FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_allocations_tenantId_invoiceId_fkey" FOREIGN KEY ("tenantId", "invoiceId") REFERENCES "invoices" ("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_payment_allocations" ("allocatedAmount", "createdAt", "currencyCode", "id", "invoiceId", "paymentId", "tenantId") SELECT "allocatedAmount", "createdAt", "currencyCode", "id", "invoiceId", "paymentId", "tenantId" FROM "payment_allocations";
DROP TABLE "payment_allocations";
ALTER TABLE "new_payment_allocations" RENAME TO "payment_allocations";
CREATE INDEX "payment_allocations_tenantId_paymentId_idx" ON "payment_allocations"("tenantId", "paymentId");
CREATE INDEX "payment_allocations_tenantId_invoiceId_idx" ON "payment_allocations"("tenantId", "invoiceId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


-- ─────────────────────────────────────────────────────────────────────────────
-- Prisma rebuilds a SQLite table to add columns (CREATE new / copy / DROP old / RENAME),
-- and DROP TABLE also drops the table's triggers. The integrity triggers of the rebuilt
-- tables are therefore re-created here, verbatim from the integrity_triggers migration.
-- (test/integrity.test.ts checks that every trigger still exists after all migrations.)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'invoices cannot be deleted; cancel instead'); END;

CREATE TRIGGER payment_allocations_no_delete BEFORE DELETE ON payment_allocations
BEGIN SELECT RAISE(ABORT, 'payment allocations cannot be deleted; reverse instead'); END;

CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'expenses cannot be deleted; cancel instead'); END;

CREATE TRIGGER invoices_issued_frozen
BEFORE UPDATE ON invoices
WHEN OLD.status <> 'DRAFT'
 AND (NEW.invoiceNumber <> OLD.invoiceNumber OR NEW.clientId <> OLD.clientId
   OR NEW.clearanceFileId <> OLD.clearanceFileId OR NEW.currencyCode <> OLD.currencyCode
   OR NEW.subtotal <> OLD.subtotal OR NEW.discount <> OLD.discount
   OR NEW.taxAmount <> OLD.taxAmount OR NEW.totalAmount <> OLD.totalAmount
   OR NEW.invoiceType <> OLD.invoiceType)
BEGIN
  SELECT RAISE(ABORT, 'issued invoices are frozen; cancel and re-issue instead');
END;

CREATE TRIGGER invoices_no_reopen
BEFORE UPDATE OF status ON invoices
WHEN OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED'
BEGIN
  SELECT RAISE(ABORT, 'cancelled invoices cannot be reopened');
END;

CREATE TRIGGER invoice_items_frozen_update
BEFORE UPDATE ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = OLD.invoiceId AND tenantId = OLD.tenantId) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'items of an issued invoice cannot be changed'); END;

CREATE TRIGGER invoice_items_frozen_delete
BEFORE DELETE ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = OLD.invoiceId AND tenantId = OLD.tenantId) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'items of an issued invoice cannot be deleted'); END;

CREATE TRIGGER invoice_items_frozen_insert
BEFORE INSERT ON invoice_items
WHEN (SELECT status FROM invoices WHERE id = NEW.invoiceId AND tenantId = NEW.tenantId) <> 'DRAFT'
BEGIN SELECT RAISE(ABORT, 'cannot add items to an issued invoice'); END;

CREATE TRIGGER expenses_approved_money_frozen
BEFORE UPDATE ON expenses
WHEN OLD.status = 'APPROVED'
 AND (NEW.amount <> OLD.amount OR NEW.currencyCode <> OLD.currencyCode
   OR NEW.exchangeRate <> OLD.exchangeRate OR NEW.baseAmount <> OLD.baseAmount)
BEGIN
  SELECT RAISE(ABORT, 'approved expenses are frozen; cancel and re-enter instead');
END;

-- ── New in Phase 5 ───────────────────────────────────────────────────────────

-- Allocations are never edited or deleted; an undone allocation is marked reversed instead.
CREATE TRIGGER payment_allocations_immutable
BEFORE UPDATE ON payment_allocations
WHEN NEW.paymentId <> OLD.paymentId OR NEW.invoiceId <> OLD.invoiceId
  OR NEW.allocatedAmount <> OLD.allocatedAmount OR NEW.currencyCode <> OLD.currencyCode
  OR NEW.paymentAmount <> OLD.paymentAmount OR NEW.paymentBaseAmount <> OLD.paymentBaseAmount
  OR NEW.invoiceBaseAmount <> OLD.invoiceBaseAmount
BEGIN
  SELECT RAISE(ABORT, 'payment allocations are immutable; reverse instead');
END;

CREATE TRIGGER payment_allocations_reversal_final
BEFORE UPDATE ON payment_allocations
WHEN OLD.reversedAt IS NOT NULL AND NEW.reversedAt IS NOT OLD.reversedAt
BEGIN
  SELECT RAISE(ABORT, 'a reversed allocation cannot be changed');
END;

-- The exchange-rate snapshot of an issued invoice never changes.
CREATE TRIGGER invoices_rate_frozen
BEFORE UPDATE ON invoices
WHEN OLD.status <> 'DRAFT' AND OLD.exchangeRate IS NOT NULL
 AND (NEW.exchangeRate IS NOT OLD.exchangeRate OR NEW.baseTotalAmount IS NOT OLD.baseTotalAmount
   OR NEW.rateConvention <> OLD.rateConvention)
BEGIN
  SELECT RAISE(ABORT, 'the exchange rate of an issued invoice is frozen');
END;
