CLEARPORT

Product Requirements, Business Plan, Database Architecture, API Specification, and Development Roadmap

Implementation handoff document for Claude AI Code Assistant

Version 1.0 — 3 November 2026

------------------------------------------------------------------------

1. PURPOSE OF THIS DOCUMENT

This document is the single source of product and technical direction
for building ClearPort.

Claude should use it as the project specification when planning,
generating, reviewing, or modifying code. Preserve the business rules
and architectural decisions described here. If a requirement is
ambiguous, identify the ambiguity and propose a safe option rather than
silently inventing behavior.

ClearPort is an office-centric Customs Brokerage & Clearance Management
System initially targeting customs clearance offices in Lebanon.

The first release is an internal office management application. It does
NOT include a client portal. Clients are business records managed by
office employees, not login users.

The product is not intended to replace the Lebanese Customs
Administration’s systems, including NAJIM, or to submit official customs
declarations without an authorized integration. In the MVP, official
declaration submission and assessment details are recorded manually by
authorized office staff.

2. PRODUCT VISION

2.1 Product name

ClearPort

Tagline: Customs Brokerage Management Software.

2.2 Core promise

Manage every customs clearance file, document, task, payment, expense,
client and employee from one platform.

2.3 Target customers

-   Small Lebanese customs brokerage offices.
-   Medium-sized customs clearance companies.
-   Larger customs brokerage firms with multiple branches and employees.

2.4 Main business problem

Customs offices often coordinate work across spreadsheets, paper
documents, email, messaging applications and separate accounting tools.
ClearPort centralizes the operational and financial lifecycle of a
clearance file.

The central product concept is:

EVERY CUSTOMS DECLARATION / CLEARANCE OPERATION IS A FILE.

A file has: - A unique office-generated file number. - One primary
client. - One or more shipments. - One or more containers. - One or more
goods lines. - Documents and document versions. - A configurable
workflow and status history. - Assigned employees and tasks. - Expenses,
invoices, payments and accounting records. - An activity timeline and
audit history.

2.5 Product positioning

Differentiate around the internal daily operations of Lebanese customs
brokerage offices:

-   File tracking and employee workload.
-   Document collection and completeness.
-   Financial control, client advances and outstanding balances.
-   Cashboxes and multiple currencies, particularly USD and LBP.
-   Cost and profitability per clearance file.
-   Arabic/English interface and printable documents.
-   Configurable workflows rather than hardcoded procedures.

Before substantial commercial investment, validate these needs with 3–5
real customs offices. Observe their actual file lifecycle and financial
practices.

3. BUSINESS SCOPE

3.1 MVP modules

The MVP should focus on:

1.  Office identity, users and permissions.
2.  Clients and business parties.
3.  Clearance files.
4.  Shipment, container and goods details.
5.  Document management.
6.  Workflow stages, tasks and activity timeline.
7.  Basic financial management: expenses, invoices, payments, advances
    and balances.
8.  Dashboard and reports.
9.  Arabic and English interface.
10. Audit history and secure tenant isolation.

3.2 Later modules

-   Configurable advanced workflow editor.
-   Client portal.
-   WhatsApp and email notifications.
-   Advanced task scheduling and escalation.
-   HS code and tariff reference database.
-   Tariff/duty estimation assistance.
-   Cashbox and bank reconciliation.
-   Advanced accounting reports.
-   OCR for invoices, packing lists and bills of lading.
-   AI-assisted document extraction and discrepancy detection.
-   HS classification suggestions requiring human review.
-   Authorized customs-system integrations, only if official interfaces
    and permissions are available.

3.3 Explicit exclusions for MVP

-   No client portal or client login.
-   No automatic submission of declarations to NAJIM or other customs
    systems.
-   No assumption that the application can calculate authoritative
    Lebanese customs duties without verified, current tariff data and
    rules.
-   No hardcoded customs process that assumes every file follows the
    same steps.
-   No microservices architecture.
-   No mobile application in the first release.

4. LEBANESE BUSINESS CONTEXT AND COMPLIANCE

Design the application for Lebanese customs brokerage workflows, but
make procedures configurable because they may vary by customs office,
goods category, clearance type and applicable approvals.

Relevant concepts include: - Import and export clearance. - Single
Administrative Document (SAD). - NAJIM electronic declaration references
where applicable. - Commercial invoices. - Packing lists. - Bills of
lading. - Delivery orders. - Certificates of origin. - Proof of
payment. - Import permits, certificates and other supporting documents
when applicable. - Customs assessment, inspection, duties and release.

The application is an office coordination and management system, not an
official customs platform.

Important implementation rules: - Record declaration reference numbers
and submission details manually in the MVP. - Keep duty and tariff data
versioned, sourced and effective-dated if introduced later. - Never
hardcode rates based on stale or unverified information. - Keep
estimated charges distinct from official assessed charges. - Require an
employee to review AI-extracted or AI-suggested data. - Confirm local
accounting, tax, invoicing, privacy and record-retention requirements
with qualified local professionals before production use.

5. CORE BUSINESS WORKFLOW

5.1 Example import clearance lifecycle

1.  Create a new clearance file.
2.  Select the client and office branch.
3.  Enter initial shipment information, if available.
4.  Assign an employee.
5.  Collect and upload documents.
6.  Review the commercial invoice, packing list, bill of lading,
    delivery order and other required documents.
7.  Record vessel, voyage, ports, containers and goods lines.
8.  Verify goods descriptions, HS code references, quantities, values,
    origin and applicable permits.
9.  Prepare and submit the official declaration through the applicable
    external process; record reference and submission details manually
    in ClearPort.
10. Record customs assessment and inspection requirements.
11. Record duties, taxes, port charges and other expenses.
12. Record client advances and payments.
13. Record customs release details and supporting documents.
14. Record transport and delivery details, where applicable.
15. Issue final client invoice and reconcile all financial transactions.
16. Close the file after required operational and financial checks.

5.2 Workflow design requirements

A clearance file must not have only a freely editable status field.

Implement workflow templates, stages, transitions and stage history. The
backend must validate transitions.

Transitions may require: - A specific permission. - Required
documents. - An approval. - A reason or note. - Completion of specified
tasks. - Other configurable rules.

Different templates may be configured for import, export and other
clearance types. The system must allow an administrator to configure
stages and transitions.

A file may be created before all shipment details are known. Do not
require every shipment field at file creation.

5.3 Example default import stages

These are seed defaults, not universal legal requirements:

1.  New file.
2.  Document collection.
3.  Pre-clearance preparation.
4.  Declaration submitted.
5.  Customs assessment / inspection.
6.  Duties and charges.
7.  Customs release.
8.  Delivery and file closure.

Stage labels and rules must be configurable.

6. FINANCIAL BUSINESS RULES

Financial integrity is a major differentiator for ClearPort.

6.1 Multiple currencies

Support USD, LBP and other currencies.

For every financial transaction preserve: - Original amount. - Original
currency. - Exchange rate used. - Exchange-rate direction / conversion
convention. - Base currency amount. - Transaction date. - Source of
exchange rate, where relevant.

Never overwrite historical exchange rates. A transaction must retain the
rate used when it was recorded.

Never use floating-point (SQLite REAL) for money or
exchange rates.

SQLite has no fixed-precision decimal type. Store money and rates as
TEXT decimal strings and compute only with a decimal library
(decimal.js / Prisma.Decimal), never JavaScript numbers.

Suggested precision, enforced in validation: - Money: 20 digits, 4
decimal places. - Exchange rate: 24 digits, 10 decimal places. -
Weights and quantities: suitable precision.

The tenant has a configured base currency. Financial reports must
clearly identify whether they show transaction currency or base-currency
equivalents.

6.2 Financial categories

Examples: - Customs duties and taxes. - Port fees. - Shipping fees. -
Transportation. - Clearance service fees. - Inspection expenses. -
Storage charges. - Other expenses.

Categories should identify whether a charge is billable to the client
and whether it is an office expense or a pass-through cost.

6.3 Client advances

A client advance is not automatically revenue.

Example: receiving a USD 1,000 advance: - Debit Cash: 1,000. - Credit
Client Advances Liability: 1,000.

The advance is held against future client charges and expenses. Apply it
through proper accounting allocations and journal entries.

6.4 Invoices and payments

-   One clearance file may have multiple invoices.
-   A file may have an advance invoice, supplementary invoice and final
    invoice.
-   One payment may be allocated across multiple invoices.
-   An invoice may receive multiple partial payments.
-   Never let the client directly set invoice paid amounts.
-   Derive outstanding amounts from payment allocations and posted
    transactions.
-   Store payment method, cash/bank account, reference and received-by
    user.
-   Corrections to issued or posted financial records must use
    controlled cancellation, reversal or adjustment flows, not silent
    edits or physical deletion.

6.5 Expense treatment

Distinguish: - Expenses paid on behalf of a client. - Expenses paid by
the office. - Billable client charges. - Office revenue / service
fees. - Refunds and reimbursements.

A file’s profitability must not simply subtract all cash movements from
all invoices without accounting for pass-through funds, advances and
liabilities.

6.6 Double-entry accounting foundation

Include accounting foundations even if the first user interface is
simplified: - Chart of accounts. - Journal entries. - Journal entry
lines. - Posting status. - Reversal entries. - Debit/credit balancing.

Every posted journal entry must satisfy:

SUM(debit) = SUM(credit)

Only posted journal entries affect accounting balances. Posted entries
are immutable. Correct them with reversal and replacement entries.

7. TECHNICAL STACK

Use the following stack unless there is a strong, documented reason to
propose a change:

Frontend: - React. - TypeScript. - Vite. - Tailwind CSS. - shadcn/ui. -
React Router. - TanStack Query. - React Hook Form. - Zod. - TanStack
Table. - Recharts. - date-fns. - i18next. - Lucide icons.

Backend: - Node.js. - TypeScript. - NestJS. - Prisma ORM. - REST API. -
class-validator or Zod for request validation; choose one consistent
backend validation strategy.

Infrastructure: - SQLite (single database file, WAL mode). - SQLite-backed
job queue for background jobs (no Redis, no BullMQ). - Host machine
filesystem storage for documents (no S3/MinIO). - Puppeteer for PDF
generation. - No Docker and no external services; the only runtime
dependency is Node.js. - Nginx or another reverse proxy for production
deployment.

Authentication: - Short-lived access tokens. - Rotating refresh
tokens. - Secure refresh-token storage and revocation. - Argon2id
password hashing.

Start with a modular monolith. Do not create microservices for the MVP.

8. SYSTEM ARCHITECTURE

Request flow:

React frontend -> HTTPS / REST API -> NestJS API -> authentication ->
tenant context -> permission guards -> domain modules -> Prisma /
SQLite

Background work: NestJS API -> SQLite jobs table -> worker process ->
document processing, PDF generation, notifications, report generation

Storage: - SQLite stores structured business data and document
metadata. - The host filesystem (a private directory outside any
web-served path) stores actual uploaded document bytes. - The job
queue is a SQLite table; there is no separate cache service.

Use REST for ordinary operations. Add WebSockets only when live
notifications or live dashboards are genuinely needed.

9. MULTI-TENANCY AND SECURITY

ClearPort is a multi-tenant SaaS platform. Multiple customs offices use
one application while their business data remains isolated.

9.1 Tenant model

-   A tenant represents one customs office / subscribing company.
-   A user may belong to one or more tenants.
-   A tenant may have one or more branches.
-   Every tenant-owned business record must contain tenant_id.
-   A user must be an active member of the selected tenant.
-   Every request must have an authenticated tenant context.
-   Never trust a tenant_id supplied by the frontend without verifying
    membership.

9.2 Tenant isolation (SQLite)

SQLite has no Row-Level Security, so there is no database-level safety
net. Isolation is enforced in the application layer, centralized, and
verified by tests.

Important: - Route ALL database access through a Prisma client
extension that injects tenant_id into every read and write. Unscoped
Prisma access is forbidden outside migrations and explicit system
tasks. - Resolve tenant context per request from the authenticated
membership; never use a global or shared variable. - Enable
PRAGMA foreign_keys=ON on every connection.
Background workers must explicitly establish tenant context. - Use
composite foreign keys containing tenant_id where practical to prevent
cross-tenant relationships. - Test cross-tenant access attempts for
every important resource.

Tenant scoping does not replace application authorization.

9.3 Authorization

Implement permission-based RBAC. Do not rely only on role names.

Example permissions: - clearance_files.view - clearance_files.create -
clearance_files.update - clearance_files.assign -
clearance_files.transition - clearance_files.close - documents.upload -
documents.review - expenses.create - expenses.approve -
invoices.create - invoices.issue - payments.create - accounting.view -
accounting.post - users.manage - settings.manage - reports.view

Suggested default roles: - Owner: full tenant access. - Admin: office
configuration and user management. - Manager: operational and financial
management. - Clearance Officer: clearance files, shipments, documents
and tasks. - Accountant: invoices, expenses, payments and accounting. -
Viewer: read-only access.

Permissions must be checked on the backend for every protected action.
Frontend route and button hiding is only a usability feature, not
security.

9.4 Other security requirements

-   Private local file storage outside any web-served directory, with
    restrictive OS permissions.
-   Short-lived signed download tokens, served through the API.
-   Verify document tenant ownership before issuing URLs.
-   Validate file size, MIME type and actual content where possible.
-   Store checksums.
-   Rate-limit authentication and sensitive endpoints.
-   Secure headers and CORS.
-   Validate and sanitize user input.
-   Record security-sensitive events.
-   Encrypt backups.
-   Provide tested backup and restore procedures.
-   Revoke refresh tokens on logout and account deactivation.
-   Never expose passwords, token hashes or internal storage paths in
    API responses.

10. DATABASE CONVENTIONS

-   Primary keys: UUID.
-   Timestamps: Prisma DateTime, stored in UTC.
-   Money: TEXT decimal string, 4 decimal places (see 6.1).
-   Exchange rates: TEXT decimal string, 10 decimal places.
-   SQLite settings: WAL mode, busy_timeout, foreign_keys=ON. Single
    application node; the database file is local to the host.
-   Use Prisma enums if supported for SQLite in the chosen Prisma
    version; otherwise constrained strings with CHECK/validation.
-   Type mapping for the entity inventory below: TIMESTAMPTZ means
    DateTime (UTC), NUMERIC means TEXT decimal string, JSONB means
    JSON text, UUID means TEXT, VARCHAR/CHAR limits are enforced by
    validation.
-   Use ISO currency codes.
-   Use ISO country codes where possible.
-   Tenant-owned records have tenant_id NOT NULL.
-   Use foreign keys and unique constraints.
-   Add created_at and updated_at to mutable business records.
-   Add created_by where accountability matters.
-   Financial records are not physically deleted.
-   Use soft deletion only where justified.
-   Use explicit enums or constrained values for stable finite states.
-   Use JSON (TEXT) only for genuinely flexible metadata, not to avoid
    relational design.
-   Use database migrations committed to version control.

For tenant-owned relations, prefer composite constraints such as:
FOREIGN KEY (tenant_id, client_id) REFERENCES clients (tenant_id, id)

11. DATABASE SCHEMA — ENTITY INVENTORY

The following is the logical schema. Claude should implement the
complete Prisma schema with correct field types, relations, indexes,
constraints, enums and migration strategy. Do not silently omit
entities.

11.1 Identity and tenant entities

tenants

-   id UUID PK
-   name VARCHAR(200)
-   slug VARCHAR(100), unique
-   legal_name VARCHAR(200), nullable
-   email VARCHAR(150), nullable
-   phone VARCHAR(50), nullable
-   address TEXT, nullable
-   default_currency CHAR(3)
-   timezone VARCHAR(50)
-   locale VARCHAR(5), e.g. en or ar
-   status: active / suspended
-   created_at

users

-   id UUID PK
-   email VARCHAR(150), unique according to chosen global-user model
-   password_hash TEXT
-   first_name VARCHAR(100)
-   last_name VARCHAR(100)
-   phone VARCHAR(50), nullable
-   is_active BOOLEAN
-   last_login_at TIMESTAMPTZ, nullable
-   created_at
-   updated_at

tenant_users

-   id UUID PK
-   tenant_id UUID FK
-   user_id UUID FK
-   branch_id UUID nullable FK
-   is_active BOOLEAN
-   joined_at
-   unique(tenant_id, user_id)

branches

-   id UUID PK
-   tenant_id UUID FK
-   code
-   name
-   address
-   phone
-   is_active
-   timestamps
-   unique(tenant_id, code)

roles

-   id UUID PK
-   tenant_id UUID nullable for system-defined roles
-   name
-   code
-   description
-   is_system BOOLEAN

permissions

-   id UUID PK
-   code unique
-   description

role_permissions

-   role_id FK
-   permission_id FK
-   composite primary key

user_roles

-   tenant_id
-   user_id
-   role_id
-   optional branch scope if needed
-   composite uniqueness and tenant-safe constraints

Also implement refresh-token/session records with hashed tokens, expiry,
revocation and device/session metadata. Do not store raw refresh tokens.

11.2 CRM entities

clients

-   id UUID PK
-   tenant_id UUID
-   client_code VARCHAR(30)
-   client_type: company / individual
-   name VARCHAR(200)
-   legal_name VARCHAR(200), nullable
-   tax_number VARCHAR(100), nullable
-   registration_number VARCHAR(100), nullable
-   phone VARCHAR(50), nullable
-   email VARCHAR(150), nullable
-   address TEXT, nullable
-   country_code CHAR(2), nullable
-   payment_terms_days INTEGER
-   credit_limit NUMERIC(20,4), nullable
-   notes TEXT, nullable
-   is_active BOOLEAN
-   timestamps
-   unique(tenant_id, client_code)

client_contacts

-   id
-   tenant_id
-   client_id
-   name
-   position
-   phone
-   email
-   is_primary
-   timestamps

business_parties

For shipping agents, freight forwarders, suppliers, transporters and
other companies. - id - tenant_id - name - party_type - tax_number -
phone - email - address - country_code - timestamps

Keep clients separate from business_parties because clients have
additional billing, credit and account-statement requirements. A company
may be both a client and a supplier/party; do not assume these roles are
mutually exclusive.

11.3 Clearance entities

clearance_files

-   id UUID PK
-   tenant_id UUID
-   file_number VARCHAR(40)
-   file_type: IMPORT / EXPORT / OTHER (extensible)
-   client_id UUID
-   branch_id UUID nullable
-   assigned_to UUID nullable
-   opened_at TIMESTAMPTZ
-   expected_arrival_at TIMESTAMPTZ nullable
-   closed_at TIMESTAMPTZ nullable
-   current_stage_id UUID nullable
-   status
-   priority: LOW / NORMAL / HIGH / URGENT
-   customs_reference VARCHAR(100), nullable
-   internal_notes TEXT nullable
-   created_by UUID
-   created_at
-   updated_at
-   unique(tenant_id, file_number)

Generate file numbers transactionally. Do not use MAX(file_number)+1.
Use a number_sequences table keyed by tenant, year and document type,
locking the sequence row while allocating a number.

Examples: IMP-2026-00001 EXP-2026-00001

shipments

-   id UUID
-   tenant_id UUID
-   clearance_file_id UUID
-   shipment_type
-   vessel_name
-   voyage_number
-   bill_of_lading_number
-   master_bl_number
-   house_bl_number
-   shipping_agent_id nullable
-   freight_forwarder_id nullable
-   origin_port_id nullable
-   destination_port_id nullable
-   etd TIMESTAMPTZ nullable
-   eta TIMESTAMPTZ nullable
-   actual_arrival_at TIMESTAMPTZ nullable
-   notes
-   timestamps

One clearance file may contain multiple shipment records.

containers

-   id UUID
-   tenant_id UUID
-   shipment_id UUID
-   container_number VARCHAR(20)
-   container_type VARCHAR(20)
-   seal_number VARCHAR(50)
-   gross_weight NUMERIC(18,3)
-   net_weight NUMERIC(18,3)
-   package_count INTEGER
-   status
-   timestamps

Validate container numbers against ISO 6346 where applicable.

goods_items

-   id UUID
-   tenant_id UUID
-   shipment_id UUID
-   description TEXT
-   hs_code_id UUID nullable
-   country_of_origin CHAR(2)
-   quantity NUMERIC(18,4)
-   unit_of_measure VARCHAR(20)
-   gross_weight NUMERIC(18,3)
-   net_weight NUMERIC(18,3)
-   unit_price NUMERIC(20,4)
-   line_total NUMERIC(20,4)
-   currency_code CHAR(3)
-   timestamps

ports

-   id UUID
-   code
-   name
-   country_code
-   port_type Seed relevant Lebanese and international ports, including
    Beirut and Tripoli.

11.4 Document entities

document_types

-   id
-   tenant_id nullable for system defaults
-   code
-   name_en
-   name_ar
-   description
-   is_active

Seed document types: - Commercial Invoice - Packing List - Bill of
Lading - Certificate of Origin - Delivery Order - Customs Declaration -
Import Permit - Payment Proof - Inspection Report - Other

documents

-   id
-   tenant_id
-   clearance_file_id
-   document_type_id
-   original_filename
-   storage_key
-   mime_type
-   file_size BIGINT
-   checksum
-   version_number
-   uploaded_by
-   uploaded_at
-   status
-   notes

Store metadata in SQLite and bytes in private host filesystem storage.

document_versions

-   id
-   tenant_id
-   document_id
-   version_number
-   storage_key
-   original_filename
-   checksum
-   uploaded_by
-   created_at

document_requirements

-   id
-   tenant_id
-   file_type
-   document_type_id
-   is_required
-   is_required_before_stage_id nullable
-   applies_to
-   optional conditions/configuration

Requirements must be configurable by clearance type and relevant
conditions. Do not assume all files require the same documents.

11.5 Workflow and operations entities

workflow_templates

-   id
-   tenant_id
-   name
-   file_type
-   description
-   is_active

workflow_stages

-   id
-   tenant_id
-   workflow_template_id
-   code
-   name_en
-   name_ar
-   sequence
-   is_terminal

workflow_transitions

-   id
-   tenant_id
-   workflow_template_id
-   from_stage_id
-   to_stage_id
-   required_permission
-   requires_document_check
-   requires_approval

file_status_history

-   id
-   tenant_id
-   clearance_file_id
-   from_stage_id
-   to_stage_id
-   changed_by
-   reason
-   changed_at

tasks

-   id
-   tenant_id
-   clearance_file_id nullable if general task
-   assigned_to
-   created_by
-   title
-   description
-   priority
-   status
-   due_at
-   completed_at
-   timestamps

file_activities

-   id
-   tenant_id
-   clearance_file_id
-   user_id
-   activity_type
-   description
-   metadata JSONB
-   created_at

Activity timeline examples: - File created. - Document uploaded. -
Employee assigned. - Stage changed. - Expense recorded. - Payment
received. - Customs reference updated. - File closed.

notifications

-   id
-   tenant_id
-   user_id
-   type
-   title
-   body
-   metadata JSONB
-   read_at
-   created_at

audit_logs

-   id
-   tenant_id
-   actor_user_id
-   action
-   entity_type
-   entity_id
-   before_data JSONB nullable
-   after_data JSONB nullable
-   ip_address nullable
-   user_agent nullable
-   created_at

Activity timeline and audit logs are different: - Activity is a
human-readable business history. - Audit logs record sensitive data
changes and accountability.

11.6 Financial entities

currencies

-   code CHAR(3) PK
-   name
-   symbol
-   decimal_places
-   is_active

exchange_rates

-   id
-   tenant_id
-   from_currency
-   to_currency
-   rate NUMERIC(24,10)
-   effective_at
-   source
-   created_by

financial_categories

-   id
-   tenant_id
-   name
-   category_type
-   is_billable_to_client
-   is_active

expenses

-   id
-   tenant_id
-   clearance_file_id nullable
-   category_id
-   vendor_id nullable
-   description
-   amount NUMERIC(20,4)
-   currency_code
-   exchange_rate NUMERIC(24,10)
-   base_amount NUMERIC(20,4)
-   expense_date
-   payment_status
-   recorded_by
-   approved_by nullable
-   timestamps

invoices

-   id
-   tenant_id
-   clearance_file_id
-   client_id
-   invoice_number
-   invoice_type
-   issue_date
-   due_date
-   currency_code
-   subtotal
-   discount
-   tax_amount
-   total_amount
-   status
-   created_by
-   timestamps

Do not store paid_amount as a freely editable value. Derive
paid/outstanding amounts from allocations and ledger data.

invoice_items

-   id
-   tenant_id
-   invoice_id
-   description
-   category_id nullable
-   quantity
-   unit_price
-   amount

payments

-   id
-   tenant_id
-   client_id nullable
-   clearance_file_id nullable
-   payment_number
-   payment_type
-   amount
-   currency_code
-   exchange_rate
-   base_amount
-   payment_method
-   cash_account_id
-   reference_number
-   payment_date
-   received_by
-   status
-   timestamps

Payment types should distinguish client payments, advances, supplier
payments, reimbursements and refunds. Model different accounting
consequences explicitly.

payment_allocations

-   id
-   tenant_id
-   payment_id
-   invoice_id
-   allocated_amount
-   currency_code
-   created_at

Support one payment allocated across multiple invoices and multiple
partial payments against one invoice. Validate currency and allocation
rules.

cash_accounts

-   id
-   tenant_id
-   name
-   account_type
-   currency_code
-   is_active

Examples: USD cashbox, LBP cashbox, bank account.

chart_of_accounts

-   id
-   tenant_id
-   account_code
-   name
-   account_type
-   parent_id nullable
-   currency_code nullable
-   is_active

journal_entries

-   id
-   tenant_id
-   entry_number
-   entry_date
-   description
-   source_type
-   source_id
-   status: DRAFT / POSTED / REVERSED
-   created_by
-   posted_at
-   created_at

journal_entry_lines

-   id
-   tenant_id
-   journal_entry_id
-   account_id
-   debit
-   credit
-   currency_code
-   exchange_rate
-   base_debit
-   base_credit
-   clearance_file_id nullable

Implement a transaction-safe posting service. Validate that total debits
equal total credits in base currency within a documented
precision/tolerance. Posted entries must be immutable. Use reversal
entries for corrections.

11.7 Reference and configuration entities

-   hs_codes
-   hs_code_versions
-   countries
-   units_of_measure
-   payment_methods
-   system_settings
-   number_sequences
-   notification_templates
-   jobs

jobs

Background job queue (see 18.4).

-   id UUID PK
-   tenant_id UUID nullable (null only for system-level jobs)
-   type VARCHAR(100)
-   payload JSON
-   status: PENDING / RUNNING / DONE / FAILED
-   attempts INTEGER
-   max_attempts INTEGER
-   run_at TIMESTAMPTZ
-   locked_at TIMESTAMPTZ, nullable
-   locked_by VARCHAR(100), nullable
-   last_error TEXT, nullable
-   created_at
-   updated_at
-   index(status, run_at)
-   index(tenant_id, type)

HS code records should include source, jurisdiction, version and
effective dates. Do not assume an international HS heading is the
complete Lebanese tariff classification.

12. ENTITY RELATIONSHIPS

Core relationships:

-   Tenant has many tenant_users.
-   User has many tenant memberships.
-   Tenant has many branches, clients, parties and clearance files.
-   Client has many clearance files.
-   Branch has many clearance files.
-   User may be assigned to many clearance files.
-   Clearance file has many shipments.
-   Shipment has many containers.
-   Shipment has many goods items.
-   HS code has many goods items.
-   Clearance file has many documents.
-   Document type categorizes many documents.
-   Document has many versions.
-   Workflow template has many stages.
-   Workflow template has many transitions.
-   Clearance file references its current workflow stage.
-   Clearance file has many status history records, tasks and
    activities.
-   Clearance file has many expenses and invoices.
-   Invoice has many invoice items.
-   Payment has many payment allocations.
-   Invoice has many payment allocations.
-   Journal entry has many journal entry lines.
-   Chart of accounts record has many journal entry lines.

Use tenant-safe foreign keys and constraints. A record in one tenant
must never reference another tenant’s client, file, document, account or
other business record.

13. IMPORTANT DATABASE INDEXES

At minimum:

-   clearance_files(tenant_id, status)
-   clearance_files(tenant_id, client_id)
-   clearance_files(tenant_id, assigned_to)
-   clearance_files(tenant_id, created_at DESC)
-   documents(tenant_id, clearance_file_id)
-   tasks(tenant_id, assigned_to, due_at)
-   expenses(tenant_id, clearance_file_id)
-   invoices(tenant_id, client_id)
-   notifications(tenant_id, user_id, created_at DESC)

Also index frequently searched: - BL numbers. - Container numbers. -
Customs references. - Invoice numbers. - Client codes. - File numbers.

Use composite unique constraints for tenant-scoped identifiers,
e.g. unique(tenant_id, file_number).

14. REST API SPECIFICATION

Base path: /api/v1

Use consistent JSON response envelopes.

Success: { “success”: true, “data”: {}, “meta”: { “page”: 1, “limit”:
20, “total”: 150 } }

Error: { “success”: false, “error”: { “code”:
“CLEARANCE_FILE_NOT_FOUND”, “message”: “Clearance file not found”,
“details”: [] } }

Use appropriate HTTP status codes, centralized exception handling,
validation and pagination.

14.1 Authentication and users

POST /auth/login POST /auth/refresh POST /auth/logout GET /auth/me POST
/auth/change-password

GET /users POST /users GET /users/:id PATCH /users/:id PATCH
/users/:id/status

GET /roles POST /roles PUT /roles/:id/permissions

Implement active tenant selection/membership validation as needed.

14.2 Clients and parties

GET /clients POST /clients GET /clients/:id PATCH /clients/:id GET
/clients/:id/files GET /clients/:id/statement GET /clients/:id/balance

GET /parties POST /parties PATCH /parties/:id

Support search, filters, sorting and pagination.

14.3 Clearance files

GET /clearance-files POST /clearance-files GET /clearance-files/:id
PATCH /clearance-files/:id POST /clearance-files/:id/assign POST
/clearance-files/:id/transition POST /clearance-files/:id/close POST
/clearance-files/:id/reopen GET /clearance-files/:id/timeline GET
/clearance-files/:id/summary GET /clearance-files/:id/costs GET
/clearance-files/:id/documents GET /clearance-files/:id/tasks

Example create request: { “fileType”: “IMPORT”, “clientId”: “uuid”,
“branchId”: “uuid”, “assignedTo”: “uuid”, “priority”: “NORMAL”,
“expectedArrivalAt”: “2026-11-15T10:00:00Z”, “internalNotes”: “First
shipment for this client” }

Backend generates file number and selects an appropriate workflow
template.

Never allow generic PATCH status changes. Use the transition endpoint so
workflow rules, permissions, document checks and approvals are enforced.

14.4 Shipments, containers and goods

POST /clearance-files/:id/shipments GET /shipments/:id PATCH
/shipments/:id

POST /shipments/:id/containers PATCH /containers/:id

POST /shipments/:id/goods PATCH /goods/:id

GET /hs-codes GET /ports

14.5 Documents

GET /document-types GET /clearance-files/:id/document-requirements POST
/clearance-files/:id/documents GET /documents/:id GET
/documents/:id/download POST /documents/:id/versions DELETE
/documents/:id PATCH /documents/:id/status

Use API-mediated upload: 1. Client sends a multipart upload to the API
(streamed, with a size limit). 2. Backend verifies tenant ownership,
size, MIME type and content, and computes the checksum. 3. Backend
writes to a temporary file, then atomically moves it to a
tenant-segregated path under the storage root. 4. Backend creates the
document record only after the file is safely stored; clean up orphan
files on failure.

Do not expose permanent public URLs or filesystem paths. Downloads go
through an authenticated API endpoint or a short-lived signed token.

14.6 Workflow and tasks

GET /workflow-templates POST /workflow-templates POST
/workflow-templates/:id/stages POST /workflow-templates/:id/transitions

GET /tasks POST /tasks PATCH /tasks/:id POST /tasks/:id/complete GET
/dashboard/my-tasks

Workflow editing is restricted to authorized office administrators.

14.7 Finance

GET /expenses POST /expenses POST /expenses/:id/approve

GET /invoices POST /invoices GET /invoices/:id POST /invoices/:id/issue
POST /invoices/:id/cancel

GET /payments POST /payments POST /payments/:id/allocate

GET /cash-accounts GET /accounting/journal-entries

GET /reports/financial-summary GET /reports/profitability

Do not allow direct editing of derived balances or paid amounts.

14.8 Dashboard and reports

GET /dashboard/overview GET /dashboard/clearance-statistics GET
/dashboard/pending-files GET /dashboard/recent-activities GET
/dashboard/financial-summary

GET /reports/clearance-files GET /reports/client-balances GET
/reports/expenses GET /reports/revenue GET /reports/profitability GET
/reports/employee-performance GET /reports/export?format=xlsx

Reports should support date range, client, employee, file type, status,
branch and currency filters.

15. FRONTEND APPLICATION STRUCTURE

Use feature-based architecture.

Suggested structure:

frontend/src/ app/ App.tsx router.tsx providers/ AuthProvider.tsx
TenantProvider.tsx ThemeProvider.tsx QueryProvider.tsx layouts/
AuthLayout.tsx DashboardLayout.tsx

features/ dashboard/ clearance-files/ clients/ shipments/ containers/
goods/ documents/ workflows/ tasks/ expenses/ invoices/ payments/
accounting/ reports/ users/ settings/

components/ ui/ tables/ forms/ dialogs/ file-upload/ currency-input/
date-range/ status-badge/

hooks/ lib/ api-client.ts permissions.ts currency.ts dates.ts
validators.ts i18n/ en/ ar/ types/ styles/

Each feature should contain its own: - API functions. - TanStack Query
hooks. - Components. - Pages. - Form schemas. - Type definitions. -
Tests where appropriate.

Example clearance-files feature:

features/clearance-files/ api/ clearance-files.api.ts
clearance-files.queries.ts components/ ClearanceFileTable.tsx
ClearanceFileForm.tsx ClearanceFileStatus.tsx ClearanceFileTimeline.tsx
ClearanceFileFilters.tsx hooks/ pages/ ClearanceFilesPage.tsx
CreateClearanceFilePage.tsx ClearanceFileDetailsPage.tsx schemas/ types/
index.ts

16. FRONTEND NAVIGATION AND UX

Main sidebar:

-   Dashboard
-   Clearance Files
-   Clients
-   Shipments
-   Documents
-   Tasks

Financial: - Invoices - Payments - Expenses - Accounting

Management: - Reports - Users & Roles - Settings

16.1 Clearance file details workspace

This is the most important screen in the application. It should be a
workspace, not a simple CRUD details page.

Header: - File number. - Client name. - File type. - Current
stage/status. - Assigned employee. - Priority. - Expected arrival.

Tabs: - Overview. - Shipments. - Documents. - Workflow. - Expenses. -
Invoices. - Tasks. - Timeline.

Quick actions: - Upload document. - Add expense. - Create invoice. -
Record payment. - Assign employee. - Change workflow stage. - Add
internal note.

The file summary should show operational status and financial summary
without confusing client charges, office revenue, pass-through expenses
and advances.

16.2 Arabic and English

Support English and Arabic from the beginning.

Arabic requirements: - Correct RTL document direction. - Correct sidebar
placement. - RTL-aware dropdowns, tables, pagination, dialogs and
forms. - Appropriate directional icons. - Localized dates and number
formatting. - Arabic and English names/labels for document types and
workflow stages. - Printable Arabic/English invoice and report
templates.

Do not implement RTL merely with text-align: right. Test the entire
interface in both directions.

17. BACKEND CODE STRUCTURE

Suggested NestJS structure:

backend/src/ main.ts app.module.ts

common/ decorators/ guards/ interceptors/ filters/ pipes/ utils/

database/ prisma.service.ts prisma.module.ts

infrastructure/ storage/ queue/ mail/ pdf/

modules/ auth/ tenants/ users/ permissions/ branches/ clients/ parties/
clearance-files/ shipments/ containers/ goods/ hs-codes/ documents/
workflows/ tasks/ expenses/ invoices/ payments/ accounting/ reports/
notifications/ audit/

workers/ document.worker.ts notification.worker.ts report.worker.ts

Keep controllers thin. Put business rules in application/domain
services. Keep module ownership clear. Avoid circular module
dependencies.

18. IMPORTANT IMPLEMENTATION DETAILS

18.1 File number generation

Use a number_sequences table. A sequence is scoped by tenant, year and
document type. Allocate numbers inside a database transaction using
an immediate write transaction (SQLite BEGIN IMMEDIATE) or an
equivalent atomic operation.

Never use MAX()+1.

18.2 Financial posting

Implement a dedicated accounting posting service: - Validate tenant
ownership. - Validate account and currency. - Validate positive
amounts. - Validate debits and credits. - Create journal entry and lines
atomically. - Post only when balanced. - Prevent mutation of posted
entries. - Reverse entries through a new reversal entry.

18.3 Document storage

-   Store bytes on the host filesystem under a configurable storage
    root, in tenant-segregated directories.
-   Store metadata in SQLite.
-   Keep the storage root outside any web-served path.
-   Generate short-lived signed download tokens.
-   Include the storage directory and the SQLite file in backups, and
    keep them consistent with each other.
-   Verify tenant ownership before every upload/download.
-   Store checksums.
-   Preserve document versions.
-   Enforce file size and type restrictions.
-   Consider malware scanning before production.

18.4 Background jobs

Use a SQLite-backed job queue (a jobs table) for: - PDF generation. -
Notifications. - Email delivery. - Scheduled task reminders. -
Document processing. - Report exports. - Future OCR.

Queue design: - Columns include tenant_id, type, payload (JSON),
status (PENDING / RUNNING / DONE / FAILED), attempts, max_attempts,
run_at, locked_at, locked_by, last_error, created_at. - A worker
process polls for due jobs and claims each one atomically (single
UPDATE inside an immediate write transaction). - Recover jobs whose
lock has expired (crashed worker). - Hide the queue behind an
interface so a different backend could replace it later.

Jobs must be idempotent where possible. Include retries, exponential
backoff, a FAILED state for exhausted jobs, and explicit tenant
context.

18.5 Audit

Record: - Actor. - Tenant. - Action. - Entity type and ID. - Before and
after values where appropriate. - Timestamp. - IP and user agent where
appropriate.

Do not log passwords, access tokens, refresh tokens, document contents
or other secrets.

18.6 Search and filtering

Implement server-side pagination, filtering and sorting. Do not load all
clearance files into the browser.

Search should cover: - File number. - Client. - BL number. - Container
number. - Customs reference. - Invoice number.

Use safe, parameterized database queries.

19. DEVELOPMENT ROADMAP

Estimated MVP schedule: approximately 8–10 weeks for a focused
implementation, subject to actual scope, testing and developer
availability. This is a planning estimate, not a guarantee.

Phase 1 — Foundation (Weeks 1–2)

-   Initialize monorepo/repository.
-   Local setup with no Docker and no external services: SQLite
    database file and local storage directory; document steps and
    provide setup scripts.
-   NestJS and Prisma setup.
-   React/Vite setup.
-   Database migrations.
-   Tenant model.
-   Authentication.
-   Tenant membership and active tenant context.
-   Roles and permissions.
-   Branches and settings.
-   Basic application layout.

Acceptance criteria: - A user can authenticate. - Tenant membership is
enforced. - Users cannot access another tenant’s data. - Initial roles
and permissions work. - Migrations and local development setup are
reproducible.

Phase 2 — CRM (Weeks 3–4)

-   Client CRUD.
-   Client contacts.
-   Business parties.
-   Search and pagination.
-   Client details and history.

Acceptance criteria: - Employees with permission can create and manage
clients. - Client codes are unique per tenant. - Client records cannot
cross tenant boundaries.

Phase 3 — Clearance files (Weeks 3–5, overlapping where practical)

-   File creation and transactional numbering.
-   Import/export types.
-   Assignment.
-   Shipment information.
-   Vessel and voyage.
-   BL details.
-   Containers.
-   Goods lines.
-   File list and details workspace.

Acceptance criteria: - Create and search a file. - File number is unique
and correctly sequenced. - Add multiple shipments, containers and goods
lines. - Assign an employee. - All relationships are tenant-safe.

Phase 4 — Documents and workflow (Weeks 5–6)

-   Local filesystem storage integration.
-   Upload/download.
-   Document types.
-   Document versions.
-   Required-document checklists.
-   Workflow templates and stages.
-   Validated stage transitions.
-   Status history.
-   Tasks.
-   Activity timeline.

Acceptance criteria: - Upload and securely retrieve documents. -
Preserve old versions. - Block configured transitions when required
conditions are unmet. - Record all stage changes and activities.

Phase 5 — Finance (Weeks 7–8)

-   Currencies and exchange rates.
-   Financial categories.
-   Expenses.
-   Invoices and invoice items.
-   Payments.
-   Payment allocations.
-   Client advances.
-   Cash accounts.
-   Chart of accounts.
-   Journal entries and posting rules.
-   File financial summary.

Acceptance criteria: - Record expenses in multiple currencies. - Issue
invoices. - Record partial payments and allocate payments. - Track
client advances separately from revenue. - Post balanced journal
entries. - Prevent editing or deleting posted financial records. -
Calculate file profitability using defined accounting rules.

Phase 6 — Reports and pilot (Weeks 9–10)

-   Dashboard.
-   Pending files.
-   Task overview.
-   Client balances.
-   Revenue and expenses.
-   File profitability.
-   PDF and Excel exports.
-   Arabic and English.
-   Audit review.
-   Security tests.
-   Backup/restore tests.
-   Pilot with a real office.

Acceptance criteria: - Key reports reconcile to underlying records. -
Arabic RTL works across the application. - Tenant isolation tests
pass. - Backup can be restored. - Office staff can complete a real test
clearance lifecycle.

20. MVP END-TO-END ACCEPTANCE SCENARIO

The first complete implementation must support this scenario:

1.  Create a customs office.
2.  Create an administrator and two employees.
3.  Create a client.
4.  Create an import clearance file.
5.  Generate its unique file number.
6.  Add a vessel, BL and container.
7.  Upload a commercial invoice and packing list.
8.  Assign the file to an employee.
9.  Move the file through its configured workflow.
10. Record a USD 500 client advance.
11. Record clearance expenses.
12. Generate a client invoice.
13. Record the final payment and allocate it.
14. Close the file.
15. Display the file’s operational history and financial profitability.

The scenario must be tested through the actual API and UI, not only unit
tests.

21. REPOSITORY STRUCTURE

Recommended repository:

clearport/ backend/ src/ prisma/ test/

frontend/ src/

infrastructure/ nginx/ scripts/ (native setup and service scripts, no
Docker)

docs/ architecture.md database.md api.md workflows.md

README.md

Use environment variables for secrets and environment-specific settings.
Commit an .env.example, never a real .env file.

22. RECOMMENDED INITIAL UI PAGES

1.  Login.
2.  Tenant/office selection if user belongs to multiple offices.
3.  Dashboard.
4.  Clearance file list.
5.  Create clearance file wizard/form.
6.  Clearance file details workspace with tabs.
7.  Clients list.
8.  Client details.
9.  Business parties list.
10. Tasks list / my tasks.
11. Documents list and preview.
12. Expenses list.
13. Invoice list and invoice details.
14. Payments list.
15. Cash accounts.
16. Reports.
17. Users and roles.
18. Workflow configuration.
19. Office settings.
20. Branch management.

23. PRODUCT AND TECHNICAL DECISIONS — SUMMARY

These decisions should be treated as defaults unless a documented
technical issue requires reconsideration:

1.  Product is ClearPort, a customs brokerage office management platform
    for Lebanon.
2.  First version is office-only. No client portal.
3.  One tenant represents one customs office/company.
4.  Users may belong to multiple tenants.
5.  Use React, TypeScript and Vite for frontend.
6.  Use NestJS and TypeScript for backend.
7.  Use SQLite and Prisma.
8.  Use a SQLite-backed job queue for background work (no Redis).
9.  Use the host machine filesystem for private document storage.
10. Use a modular monolith.
11. Use REST API under /api/v1.
12. Use UUID primary keys.
13. Store monetary values and exchange rates as decimal strings, never
    floats.
14. Support USD and LBP and preserve historical exchange rates.
15. A clearance file has one primary client initially.
16. A clearance file may have multiple shipments.
17. A shipment may have multiple containers and goods lines.
18. A file may have multiple invoices.
19. Payments may be allocated across multiple invoices.
20. Client advances are liabilities until properly applied, not
    automatically revenue.
21. Financial postings are immutable; corrections use reversals.
22. Workflow stages and transitions are configurable.
23. Workflow transitions use a dedicated API, not generic status PATCH.
24. Document requirements are configurable.
25. Every tenant-owned record is tenant-scoped.
26. Enforce tenant isolation in the application layer through a
    tenant-scoped Prisma extension (SQLite has no RLS).
27. Audit logs and human-readable activity timeline are separate.
28. Arabic and English are supported from the beginning.
29. No direct NAJIM integration in MVP.
30. No automatic duty calculation until verified tariff data and rules
    exist.
31. AI-extracted data must be reviewed by a human.
32. Pilot with real customs offices before expanding scope.
33. Do not use Docker or containers. There are no external
    services: SQLite and local file storage need no installation. The
    only runtime dependency is Node.js; document the setup steps in
    README and provide scripts where practical.

24. INSTRUCTIONS TO CLAUDE AI CODE ASSISTANT

Use this document as the product and architecture specification.

Before generating large amounts of code:

1.  Inspect the existing repository, if one exists.
2.  Identify current files, framework versions, scripts and conventions.
3.  Do not overwrite working code without understanding it.
4.  Summarize the proposed implementation plan.
5.  Identify ambiguities and high-risk decisions.
6.  Propose a phased implementation and wait for confirmation if the
    user requests planning first.

When implementing:

-   Work in small, testable milestones.
-   Implement database schema and migrations before dependent API
    features.
-   Use Prisma migrations; do not rely on db push as the production
    migration strategy.
-   Generate and maintain seed data for system roles, permissions,
    currencies, document types, workflow defaults and reference data.
-   Use DTOs and strict validation.
-   Use typed API contracts.
-   Keep controllers thin and business logic in services.
-   Use database transactions for multi-record operations, numbering and
    financial posting.
-   Enforce tenant scope in every service and query.
-   Add authorization checks to every protected operation.
-   Never trust tenant IDs or ownership IDs from the frontend without
    validating them.
-   Never expose secrets or private document storage paths.
-   Add unit tests for business rules.
-   Add integration tests for database behavior and tenant isolation.
-   Add end-to-end tests for the complete clearance lifecycle.
-   Add financial reconciliation tests.
-   Add Arabic RTL tests.
-   Keep README and architecture documentation current.
-   Provide clear setup, migration, seed and test commands.
-   Do not introduce microservices or unnecessary abstractions.
-   Do not implement all planned future features in the MVP.
-   If the specification conflicts with local law or current official
    procedures, flag the issue and request verified requirements rather
    than guessing.

First implementation task

Start by producing: 1. A repository inspection report (if code already
exists). 2. A proposed implementation checklist. 3. A complete initial
Prisma schema covering the MVP entities and the financial foundation. 4.
An ERD in Mermaid. 5. Initial seed data for roles, permissions,
currencies, document types and default workflow templates. 6. Database
migrations. 7. Tests for tenant-safe relationships and file-number
generation.

Do not begin with the entire UI. First establish a reliable database and
backend foundation.

------------------------------------------------------------------------

END OF CLEARPORT SPECIFICATION
