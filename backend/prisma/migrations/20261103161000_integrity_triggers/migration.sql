-- ClearPort: integrity triggers that Prisma cannot express in schema.prisma.
-- SQLite has no RLS, CHECK-after-create or partial-index support that Prisma tracks, so these
-- rules are enforced with triggers as a database-level backstop. The service layer must still
-- validate and give friendly errors.

-- ── 1. Uniqueness of system-defined rows (tenantId IS NULL) ─────────────────────────
-- SQLite treats NULLs as distinct in UNIQUE constraints, so UNIQUE(tenantId, code) does not
-- stop duplicate system rows.

CREATE TRIGGER roles_system_code_unique
BEFORE INSERT ON roles
WHEN NEW.tenantId IS NULL AND EXISTS (SELECT 1 FROM roles WHERE tenantId IS NULL AND code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'duplicate system role code');
END;

CREATE TRIGGER document_types_system_code_unique
BEFORE INSERT ON document_types
WHEN NEW.tenantId IS NULL AND EXISTS (SELECT 1 FROM document_types WHERE tenantId IS NULL AND code = NEW.code)
BEGIN
  SELECT RAISE(ABORT, 'duplicate system document type code');
END;

CREATE TRIGGER system_settings_global_key_unique
BEFORE INSERT ON system_settings
WHEN NEW.tenantId IS NULL AND EXISTS (SELECT 1 FROM system_settings WHERE tenantId IS NULL AND key = NEW.key)
BEGIN
  SELECT RAISE(ABORT, 'duplicate global setting key');
END;

CREATE TRIGGER notification_templates_global_unique
BEFORE INSERT ON notification_templates
WHEN NEW.tenantId IS NULL AND EXISTS (
  SELECT 1 FROM notification_templates WHERE tenantId IS NULL AND code = NEW.code AND locale = NEW.locale)
BEGIN
  SELECT RAISE(ABORT, 'duplicate global notification template');
END;

-- ── 2. Journal entries: posted entries are immutable; posting requires balance ──────

-- Posting: DRAFT -> POSTED requires at least two lines and SUM(base debit) = SUM(base credit)
-- (compared in integer units of 0.0001 to avoid float noise; exact decimal check is done in
-- the posting service, this is the backstop).
CREATE TRIGGER journal_entries_post_requires_balance
BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'DRAFT' AND NEW.status = 'POSTED'
BEGIN
  SELECT RAISE(ABORT, 'journal entry needs at least two lines to post')
  WHERE (SELECT COUNT(*) FROM journal_entry_lines WHERE journalEntryId = NEW.id AND tenantId = NEW.tenantId) < 2;

  SELECT RAISE(ABORT, 'journal entry is not balanced')
  WHERE (SELECT COALESCE(SUM(CAST(ROUND(CAST(baseDebit AS REAL) * 10000) AS INTEGER)), 0)
           FROM journal_entry_lines WHERE journalEntryId = NEW.id AND tenantId = NEW.tenantId)
     <> (SELECT COALESCE(SUM(CAST(ROUND(CAST(baseCredit AS REAL) * 10000) AS INTEGER)), 0)
           FROM journal_entry_lines WHERE journalEntryId = NEW.id AND tenantId = NEW.tenantId);
END;

-- A POSTED entry can only move to REVERSED; no other column may change.
CREATE TRIGGER journal_entries_posted_immutable
BEFORE UPDATE ON journal_entries
WHEN OLD.status IN ('POSTED', 'REVERSED')
 AND NOT (
      OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
  AND NEW.id = OLD.id AND NEW.tenantId = OLD.tenantId AND NEW.entryNumber = OLD.entryNumber
  AND NEW.entryDate = OLD.entryDate AND NEW.description = OLD.description
  AND NEW.sourceType IS OLD.sourceType AND NEW.sourceId IS OLD.sourceId
  AND NEW.reversalOfId IS OLD.reversalOfId AND NEW.createdBy = OLD.createdBy
  AND NEW.postedAt IS OLD.postedAt)
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries are immutable; create a reversal entry');
END;

CREATE TRIGGER journal_entries_no_delete_after_draft
BEFORE DELETE ON journal_entries
WHEN OLD.status <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'posted journal entries cannot be deleted');
END;

-- Lines may only be changed while the parent entry is a DRAFT.
CREATE TRIGGER journal_lines_no_insert_unless_draft
BEFORE INSERT ON journal_entry_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.journalEntryId AND tenantId = NEW.tenantId) <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'cannot add lines to a posted journal entry');
END;

CREATE TRIGGER journal_lines_no_update_unless_draft
BEFORE UPDATE ON journal_entry_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journalEntryId AND tenantId = OLD.tenantId) <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'cannot modify lines of a posted journal entry');
END;

CREATE TRIGGER journal_lines_no_delete_unless_draft
BEFORE DELETE ON journal_entry_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.journalEntryId AND tenantId = OLD.tenantId) <> 'DRAFT'
BEGIN
  SELECT RAISE(ABORT, 'cannot delete lines of a posted journal entry');
END;

-- Each line is either a debit or a credit, never negative, never both.
CREATE TRIGGER journal_lines_valid_amounts_insert
BEFORE INSERT ON journal_entry_lines
WHEN CAST(NEW.debit AS REAL) < 0 OR CAST(NEW.credit AS REAL) < 0
  OR CAST(NEW.baseDebit AS REAL) < 0 OR CAST(NEW.baseCredit AS REAL) < 0
  OR (CAST(NEW.debit AS REAL) > 0 AND CAST(NEW.credit AS REAL) > 0)
BEGIN
  SELECT RAISE(ABORT, 'journal line amounts must be non-negative and one-sided');
END;

-- ── 3. Financial records are never physically deleted ──────────────────────────────

CREATE TRIGGER invoices_no_delete BEFORE DELETE ON invoices
BEGIN SELECT RAISE(ABORT, 'invoices cannot be deleted; cancel instead'); END;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payments cannot be deleted; cancel or reverse instead'); END;

CREATE TRIGGER payment_allocations_no_delete BEFORE DELETE ON payment_allocations
BEGIN SELECT RAISE(ABORT, 'payment allocations cannot be deleted; reverse instead'); END;

CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'expenses cannot be deleted; cancel instead'); END;

-- ── 4. Issued invoices: money and identity fields are frozen ───────────────────────

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

-- ── 5. Posted payments / approved expenses keep their historical exchange rate ─────

CREATE TRIGGER payments_posted_money_frozen
BEFORE UPDATE ON payments
WHEN OLD.status <> 'DRAFT'
 AND (NEW.amount <> OLD.amount OR NEW.currencyCode <> OLD.currencyCode
   OR NEW.exchangeRate <> OLD.exchangeRate OR NEW.baseAmount <> OLD.baseAmount
   OR NEW.paymentType <> OLD.paymentType OR NEW.cashAccountId <> OLD.cashAccountId
   OR NEW.paymentNumber <> OLD.paymentNumber)
BEGIN
  SELECT RAISE(ABORT, 'posted payments are frozen; reverse instead');
END;

CREATE TRIGGER expenses_approved_money_frozen
BEFORE UPDATE ON expenses
WHEN OLD.status = 'APPROVED'
 AND (NEW.amount <> OLD.amount OR NEW.currencyCode <> OLD.currencyCode
   OR NEW.exchangeRate <> OLD.exchangeRate OR NEW.baseAmount <> OLD.baseAmount)
BEGIN
  SELECT RAISE(ABORT, 'approved expenses are frozen; cancel and re-enter instead');
END;

-- ── 6. Append-only tables ──────────────────────────────────────────────────────────

CREATE TRIGGER exchange_rates_no_update BEFORE UPDATE ON exchange_rates
BEGIN SELECT RAISE(ABORT, 'exchange rates are append-only'); END;
CREATE TRIGGER exchange_rates_no_delete BEFORE DELETE ON exchange_rates
BEGIN SELECT RAISE(ABORT, 'exchange rates are append-only'); END;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit logs are append-only'); END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit logs are append-only'); END;

CREATE TRIGGER file_status_history_no_update BEFORE UPDATE ON file_status_history
BEGIN SELECT RAISE(ABORT, 'status history is append-only'); END;
CREATE TRIGGER file_status_history_no_delete BEFORE DELETE ON file_status_history
BEGIN SELECT RAISE(ABORT, 'status history is append-only'); END;

CREATE TRIGGER document_versions_no_update BEFORE UPDATE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document versions are append-only'); END;
CREATE TRIGGER document_versions_no_delete BEFORE DELETE ON document_versions
BEGIN SELECT RAISE(ABORT, 'document versions are append-only'); END;

-- ── 7. File numbers never change once assigned ─────────────────────────────────────

CREATE TRIGGER clearance_files_number_immutable
BEFORE UPDATE OF fileNumber ON clearance_files
WHEN NEW.fileNumber <> OLD.fileNumber
BEGIN
  SELECT RAISE(ABORT, 'file number is immutable');
END;
