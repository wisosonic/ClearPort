# ClearPort — Backend architecture

Modular monolith: NestJS 11 + Prisma 7 + SQLite. REST under `/api/v1`. See
[database.md](database.md) for the schema and [frontend.md](frontend.md) for the web app.
The backend covers Phases 1–6 (516 tests); the frontend foundation is in place.

## Request pipeline

```
HTTP → helmet/CORS → ThrottlerGuard → JwtAuthGuard → PermissionsGuard
     → TenantContextInterceptor → Zod pipes → controller → service
     → TenantDbService (tenant-scoped Prisma) → SQLite
     ← EnvelopeInterceptor / AllExceptionsFilter  → { success, data, meta } | { success:false, error }
```

| Step | What it guarantees |
|---|---|
| `JwtAuthGuard` | Verifies the access token, then **re-checks on every request** that the user is active, is an active member of the token's tenant, the tenant is active, and the session family is not revoked. Permissions are loaded from the user's roles in that tenant. A forged or stale `tid` cannot reach another office, and deactivation / role changes apply immediately. |
| `PermissionsGuard` | **Deny by default.** A route must be `@Public()`, `@Authenticated()` or declare `@RequirePermissions(...)`; otherwise it is rejected. |
| `TenantContextInterceptor` | Puts the verified tenant into an `AsyncLocalStorage` context for the rest of the request. |
| `TenantDbService` | Returns a Prisma client forced to that tenant (see below). No tenant context → error. |

## Tenant isolation (replaces Postgres RLS)

1. **Tenant-scoped Prisma extension** (`src/database/tenant-scope.ts`): every read/update/delete is
   filtered by `tenantId`, every create is stamped with it (a different value is rejected), system rows
   (`tenantId NULL`: roles, document types, ...) are readable but never writable, and identity models
   (`User`, `Tenant`, `RefreshSession`) are unreachable. Business modules must use `TenantDbService`.
2. **Composite foreign keys** make cross-tenant references impossible even for nested writes.
3. The root client (`PrismaService`) is for auth, provisioning, audit and workers only.
   Raw SQL bypasses the extension — never use it with user-influenced tenant values.

## Authentication

* Argon2id password hashes; minimum 10 characters.
* Access token: HS256 JWT, 15 min (`ACCESS_TOKEN_TTL_SECONDS`), claims `sub`, `tid`, `sid`.
* Refresh token: opaque random value, only its SHA-256 hash is stored; **rotated on every use**.
  Replaying an already-rotated token revokes the whole session family (theft assumption).
  Logout, password change and deactivation revoke sessions (access tokens die at once because the
  guard checks the session).
* Unknown e-mail and wrong password are indistinguishable (same error, same work factor).
* Auth endpoints are rate-limited per IP (`RATE_LIMIT_AUTH`, default 10/min).
* Multi-office users: `POST /auth/login` returns `tenantSelectionRequired` + the office list when
  several apply; sign in with `tenantSlug`, or `POST /auth/switch-tenant` while signed in.

## Endpoints implemented

| Area | Endpoints | Permission |
|---|---|---|
| Health | `GET /health` | public |
| Auth | `POST /auth/login`, `/auth/refresh`; `POST /auth/logout`, `/auth/change-password`, `/auth/switch-tenant`; `GET /auth/me` | public / authenticated |
| Office | `GET /tenant`; `PATCH /tenant` | authenticated / `settings.manage` |
| Branches | `GET /branches`; `POST`, `PATCH /branches/:id` | authenticated / `settings.manage` |
| Users | `GET/POST /users`, `GET/PATCH /users/:id`, `PATCH /users/:id/status` | `users.manage` |
| Roles | `GET /roles` (`users.manage`); `GET /permissions`, `POST /roles`, `PUT /roles/:id/permissions` (`roles.manage`) | see left |

| Clients | `GET/POST /clients`, `GET/PATCH /clients/:id` | `clients.view` / `clients.manage` |
| Contacts | `POST /clients/:id/contacts`, `PATCH/DELETE /clients/:id/contacts/:contactId` | `clients.manage` |
| Client history | `GET /clients/:id/files` | `clients.view` + `clearance_files.view` |
| Client money | `GET /clients/:id/balance`, `GET /clients/:id/statement` | `clients.view` + `invoices.view` + `payments.view` |
| Parties | `GET /parties`, `GET /parties/:id`; `POST`, `PATCH /parties` | `clients.view` / `clients.manage` |
| Clearance files | `GET/POST /clearance-files`, `GET/PATCH /clearance-files/:id`, `POST /clearance-files/:id/assign`, `GET /clearance-files/:id/timeline`, `GET /clearance-files/:id/summary` | `clearance_files.view` / `.create` / `.update` / `.assign` |
| Shipments | `GET/POST /clearance-files/:id/shipments`, `GET/PATCH /shipments/:id` | `clearance_files.view` / `.update` |
| Containers, goods | `POST /shipments/:id/containers`, `PATCH /containers/:id`, `POST /shipments/:id/goods`, `PATCH /goods/:id` | `clearance_files.update` |
| Reference | `GET /ports`, `GET /hs-codes` | `clearance_files.view` |
| Documents | `GET /documents`, `GET /documents/:id`, `GET/POST /clearance-files/:id/documents`, `GET /documents/:id/download`, `GET /documents/:id/link`, `POST /documents/:id/versions` | `documents.view` / `documents.upload` |
| Document review | `PATCH /documents/:id/status`; `DELETE /documents/:id` (void) | `documents.review` / `documents.delete` |
| Signed download | `GET /downloads/:token` | public, short-lived signed token |
| Document types | `GET /document-types`; `POST`, `PATCH /document-types` | `documents.view` / `settings.manage` |
| Requirements | `GET /clearance-files/:id/document-requirements`; `GET/POST/PATCH/DELETE /document-requirements` | `clearance_files.view` / `workflows.manage` |
| Workflow config | `GET /workflow-templates`; `POST`, `PATCH` templates; `POST`, `PATCH` stages; `POST`, `PATCH`, `DELETE` transitions | `clearance_files.view` / `workflows.manage` |
| Moving files | `GET /clearance-files/:id/transitions`, `POST .../transition`, `GET .../status-history`, `GET .../closure-check`, `POST .../close`, `POST .../reopen` | view; transition's own permission; `clearance_files.close` |
| Tasks | `GET/POST /tasks`, `GET/PATCH /tasks/:id`, `POST /tasks/:id/complete`, `GET /clearance-files/:id/tasks`, `GET /dashboard/my-tasks` | `tasks.view` / `tasks.manage` |
| Currencies, rates | `GET /currencies`, `GET /exchange-rates`, `GET /exchange-rates/latest`; `POST /exchange-rates` | authenticated / `accounting.post` |
| Setup | `GET/POST/PATCH /financial-categories`; `GET/PUT /settings/tax` | authenticated / `settings.manage` |
| Expenses | `GET/POST /expenses`, `GET/PATCH /expenses/:id`; `POST .../approve`, `.../pay`, `.../cancel` | `expenses.view` / `.create` / `.approve` |
| Invoices | `GET/POST /invoices`, `GET/PATCH /invoices/:id`, `GET /clearance-files/:id/invoices`; `POST .../issue`, `.../cancel` | `invoices.view` / `.create` / `.issue` |
| Payments | `GET/POST /payments`, `GET /payments/:id`; `POST .../allocate`, `.../allocations/:id/reverse`, `.../cancel` | `payments.view` / `payments.create` |
| Accounting | `GET /accounting/accounts`, `GET/POST /accounting/journal-entries`, `POST .../:id/reverse`, `GET /accounting/trial-balance`; `GET/POST/PATCH /cash-accounts` | `accounting.view` / `accounting.post` (cash accounts: `payments.view`) |
| Reports | `GET /clearance-files/:id/costs`, `GET /reports/profitability`, `GET /reports/financial-summary` | `reports.view` |

CRM rules: client codes are unique per office, auto-generated as `CLT-00001` or typed by hand, and
**immutable** once created; clients are deactivated, never deleted; a client with contacts always has
exactly one primary contact; business parties are independent of clients (the same company may be both).

### Client balance and statement (definition v1)

Read-only views over invoices, payments and allocations, in **transaction currencies** (never silently
converted to base currency). *To be confirmed with an accountant before Phase 5 builds the posting rules.*

| Term | Meaning |
|---|---|
| invoiced | ISSUED invoices (draft and cancelled ignored) |
| received | POSTED client payments and advances |
| refunded | POSTED refunds / reimbursements paid back to the client |
| allocated | allocations of POSTED payments to ISSUED invoices (same currency assumed) |
| outstanding | invoiced − allocated |
| unappliedCredit | received − refunded − allocated (advances held; a **liability**, not revenue) |
| netBalance | outstanding − unappliedCredit (positive: client owes the office) |

The statement's closing balance per currency always equals `netBalance` (covered by a test).

## Clearance files (Phase 3)

* **Numbering:** `IMP-2026-00001` / `EXP-` / `OTH-`, allocated from `number_sequences` *inside the creation transaction*
  using the calendar year in the **office's timezone**. The backend also picks the workflow template (oldest active one
  for the file type), sets the first stage and writes the initial status-history row. An office with no active template
  can still create files (no stage).
* **No generic status change.** `PATCH` rejects `status`, `currentStageId`, `fileNumber`, `fileType`, `assignedTo` and
  `closedAt` (400). Stages move only through the transition endpoint (Phase 4); assignment has its own endpoint.
* **Closed / cancelled files are read-only** (409 `FILE_NOT_EDITABLE`) for the file, its shipments, containers and goods.
* The **client** can change only while no invoice, payment or expense exists for the file.
* **Assignment** requires an *active* member of the office, is logged on the timeline and notifies the assignee.
* **Containers:** ISO 6346 enforced. A wrong check digit is always rejected (with the expected digit); a number not in ISO
  format is accepted only with an explicit `nonStandardNumber: true`. Net weight cannot exceed gross weight.
* **Goods lines:** when quantity and unit price are both known the server computes `lineTotal = quantity × unitPrice`
  (a client-supplied total is ignored); otherwise a given total is kept. A currency is required with any price.
* **Search** (`?search=`) covers file number, customs reference, client name/code, BL / master / house BL, vessel name,
  container number (spaces, hyphens, case ignored) and invoice number.
* **Timeline** (`file_activities`) is the human-readable history; the audit log is separate and also written.
* **HS codes** are not seeded: an international heading is not the Lebanese tariff classification, so the table must be
  loaded from a verified source. Goods lines accept an `hsCodeId` once codes exist.
* Not yet implemented: stage transitions, close / reopen, documents, tasks, costs (Phases 4–5). Shipments, containers and
  goods lines cannot be deleted (not in the spec) — to be decided.

## Documents (Phase 4)

* **Storage:** bytes live under `STORAGE_ROOT/tenants/<tenant>/files/<file>/<document>/v<N>-<random>` — the user's file
  name is metadata only, never a path. Buckets are replaced by a private directory; the API never returns a path or key.
* **Upload** is API-mediated (replaces the pre-signed S3 flow): multipart `file` field → streamed to a private temp file
  (size-limited by `MAX_UPLOAD_MB`) → content verified → SHA-256 + size computed → atomically moved into place → DB rows
  written. The interceptor deletes the temp file on **every** outcome, and a failed DB write removes the moved bytes.
* **Content is verified from the bytes**, not the browser's Content-Type or the extension. Allowed: PDF, PNG, JPEG, GIF,
  TIFF, DOCX, XLSX, DOC, XLS, TXT, CSV. A name/content mismatch (415 `FILE_TYPE_MISMATCH`) and anything else, including
  HTML/SVG/executables/archives (415 `UNSUPPORTED_FILE_TYPE`), is refused. Arabic file names are preserved.
  *Malware scanning (e.g. ClamAV) should be added before production.*
* **Versions:** every upload of a new version is kept (`document_versions`, append-only); the document row always describes
  the current one and its review status resets to `PENDING_REVIEW`. Old versions download with `?version=N`.
* **Download:** `GET /documents/:id/download` streams after verifying tenant ownership (`nosniff`, `no-store`, UTF-8 file
  name; `?disposition=inline` only for PDF/PNG/JPEG/GIF and then sandboxed by CSP). `GET /documents/:id/link` returns a
  **60-second signed link** (`/downloads/<token>`) for viewers that cannot send headers; redeeming it re-checks that the
  requester is still an active member. Every download is audited.
* **Review and void:** documents are reviewed (`APPROVED` / `REJECTED` with a mandatory reason). `DELETE` **voids** the
  document (record and bytes are kept for retention); voided documents leave lists, checklists and downloads.
* Documents of closed files are read-only.

### Required-document checklists

Requirements are configurable per file type and optionally per stage (`document_requirements`). A requirement is
**satisfied** when the file has at least one non-void, non-rejected document of that type. A required document **with a
stage** must exist before the file *enters* that stage; one **without a stage** must exist before the file can be
**closed**. The `conditions` field is stored for the UI but **not yet evaluated** by the backend.

## Workflow (Phase 4)

* **The only way to change a stage** is `POST /clearance-files/:id/transition` (`toStageCode` or `toStageId`, optional
  `reason`). `GET .../transitions` returns the legal next steps and, per step, `allowed` plus the **blockers** — it runs
  the same evaluation as enforcement, so a UI built on it can never disagree with the backend.
* A transition may require: a **permission** (its own `requiredPermission`, default `clearance_files.transition`), a
  **reason** (≥ 3 chars), the **required documents**, **no open tasks**, and **approval** (see below). Blocked moves
  answer 403 (permission / approval), 409 (not allowed / file not active) or 422 (reason, documents, tasks) with the full
  blocker list in `error.details`.
* **Approval (v1):** a transition flagged `requiresApproval` can be made only by a user holding
  `clearance_files.approve` (Owner / Admin / Manager). There is no separate request-and-approve queue yet.
* **Reaching the final stage does not close the file.** `POST .../close` (needs `clearance_files.close`) requires the final
  stage, no open tasks, the required documents, and no draft invoices. Issued-but-unpaid invoices are a **warning** that
  needs `acknowledgeOutstanding: true`; the acknowledged balance is written to the audit log. `GET .../closure-check`
  previews all of this. `POST .../reopen` needs a reason and returns the file to the stage it came from.
* **Configuration:** one *active* template per file type is used for new files (activating one deactivates the others);
  files in flight keep the template they were created with. New templates start inactive. Terminal stages have no
  outgoing transitions; permission codes on transitions must exist.
* Every move writes an append-only `file_status_history` row, a timeline entry, an audit entry, and notifies the
  assignee when someone else moved the file.

## Tasks (Phase 4)

Tasks may belong to a file or be general. Creating / reassigning needs `tasks.manage`; the **assignee** may move their own
task between OPEN / IN_PROGRESS / CANCELLED and complete it without `tasks.manage`. Completion stamps `completedAt`; a
completed task can only be reopened. Open tasks can block a workflow transition. `GET /dashboard/my-tasks` groups the
caller's open tasks into overdue / due today / upcoming / no date using the **office's time zone**. Assigning notifies the
assignee. *Scheduled reminders need the background job worker (not built yet).*

## Finance (Phase 5)

### Accounting model

Every business event posts a **balanced journal entry automatically, in the same database transaction** as the event
(`AccountingService.post`, the only way entries are created). Totals must match **exactly in base currency**; the database
trigger re-checks on posting and makes posted entries immutable. Corrections are **reversals** (a mirror entry; the original
is marked `REVERSED`, both stay). Balances include `POSTED` and `REVERSED` entries, because the reversal offsets the original.

| Event | Journal entry |
|---|---|
| Expense approved (pass-through category) | Dr **1300** Client disbursements receivable / Cr cash, or **2200** Accounts payable if unpaid |
| Expense approved (office-cost category) | Dr **5100** Office operating expenses / Cr cash or **2200** |
| Payable paid later | Dr **2200** / Cr cash (+ FX difference if the rate moved) |
| Invoice issued | Dr **1200** Receivables / Cr **4100** Service revenue, Cr **2300** Tax, Cr **1300** (each re-billed expense, at its original value) |
| Advance invoice issued | *nothing* — it is a request for funds, not a sale |
| Payment / advance received | Dr cash / Cr **2100** Client advances (a **liability**) |
| Payment allocated to an invoice | Dr **2100** / Cr **1200** (+ FX line **4300** when the two sides differ in base value) |
| Refund of unapplied credit | Dr **2100** / Cr cash |
| Any cancellation or reversal | mirror entry; the business record keeps its history |

**Revenue is recognised only when an invoice is issued, and only for service fees.** Money received is never income;
pass-through costs are never income or expense.

### Exchange rates and currencies

* Rates are stored per **foreign** currency against the office's **base** currency with an explicit **convention**:
  `BASE_PER_FOREIGN` or `FOREIGN_PER_BASE`. LBP is stored as `FOREIGN_PER_BASE` (89,500 per USD) because 1 LBP in USD
  (0.0000111732…) cannot be held exactly in 10 decimals; 0-decimal currencies default to that convention.
* `exchange_rates` is **append-only**. A transaction uses the latest rate effective on/before its date, or a rate given on
  the transaction itself (`exchangeRate`, `rateConvention`, `rateSource`). There is **no guessing**: a missing rate is a
  `422 EXCHANGE_RATE_REQUIRED`. Every expense, invoice, payment and journal line **keeps the rate it used**.
* An entry that values its two sides at different rates (cross-currency allocation; a payable settled at a later rate) books
  the difference as a **realized FX gain/loss on 4300**, so it still balances exactly. Liability balances are carried at
  historical rates; **periodic revaluation is not implemented**.

### Invoices, payments, allocations

* Invoices are **DRAFT** (editable, `DRAFT-xxxxxxxx`, no accounting) → **ISSUED** (gapless `INV-YYYY-NNNNN`, frozen, posted) →
  **CANCELLED** (reversed; refused while payments are applied). Lines are priced server-side (quantity × unit price).
* A **pass-through line must re-bill an approved expense at cost** (`expenseId`); a pass-through category without one is
  refused. An expense can sit on at most one live invoice. Cost-only categories cannot be invoiced.
* **Discount** is a pre-tax reduction of *service fees* only, spread pro-rata (remainder to the largest line). **Tax** is
  entered per office (`PUT /settings/tax`, off by default; never hardcoded), applied to *taxable categories*, and its rate is
  **snapshotted on every line**. A draft previews the tax; issuing recomputes at the current rate.
* **Paid / outstanding / status are derived** from allocations on every read — there is no `paid_amount` column.
* A payment can be **allocated across several invoices**, an invoice can take **several partial payments**, and an
  allocation can **cross currencies** (converted at the payment date's rate unless `invoiceAmount` is given). The allocation
  that exhausts a payment or closes an invoice takes the exact remainder, so rounding never leaves residue.
  Allocations are never edited or deleted: `…/allocations/:id/reverse` marks them reversed and reverses the entry.
* **Advance invoices cannot be allocated** (they are requests). Money sent against one is received as an advance.
* **Refunds** return only unapplied credit, measured **per currency**.

### Reports (base currency, from posted journal lines)

* **File profitability = service revenue − office costs.** Pass-through (disbursed / re-billed / *unrecovered*), tax
  collected, advances and realized FX are reported on separate lines and excluded from profit.
* `GET /reports/profitability` lists files with report-wide totals (in `meta.totals`, covering *all* matching files);
  `GET /reports/financial-summary` gives the position at the end date and the period's results. Both reconcile to the trial
  balance (tested). Original-currency totals are shown separately and labelled.
* The remaining reports, exports and dashboards are in the Phase 6 section below.

### Safeguards worth knowing

* Closed files are read-only for money too (create/issue/approve/allocate/reverse → `FILE_NOT_EDITABLE`).
* Money lists sort **numerically** (money is stored as text; a database `ORDER BY` would compare strings).
* `test/migrations.test.ts` asserts that no integrity trigger is lost: **adding a column makes Prisma rebuild the SQLite
  table, which silently drops its triggers.** The finance migration re-creates them for that reason.

## Reports, dashboard, export and printing (Phase 6)

Every report is built once as a uniform `ReportTable` (bilingual column headers, rows, totals, meta) and rendered four ways
from the same data, so the screen, Excel, CSV and PDF can never disagree: JSON (`GET /reports/<name>`), XLSX/CSV/PDF
(`GET /reports/export?report=<name>&format=xlsx|csv|pdf&locale=en|ar`).

| Area | Endpoints | Permission |
|---|---|---|
| Operational reports | `GET /reports/clearance-files`, `/client-balances`, `/expenses`, `/revenue` (month or client), `/employee-performance` | `reports.view` (+ file/expense/user access as applicable) |
| Export | `GET /reports/export` (also profitability, financial-summary, trial-balance) | `reports.export` plus the report's own permission; every export is audited (`REPORT_EXPORTED`) |
| Dashboard | `GET /dashboard/overview`, `/clearance-statistics`, `/pending-files`, `/recent-activities`, `/financial-summary` | each block only with the permission it needs |
| Printing | `GET /invoices/:id/pdf`, `GET /clients/:id/statement/pdf` (`?locale=ar` = right-to-left, `?format=html`) | `invoices.view` / `clients.view`; audited |

* **Numbers stay numbers** in Excel; CSV has a BOM (Excel opens Arabic correctly) and neutralises formula injection (`=`, `+`, `-`, `@`).
* **PDF** uses the Chrome/Edge/Chromium already on the machine (`puppeteer-core`, nothing downloaded; set `CHROME_PATH` if it is not found,
  `PDF_NO_SANDBOX=true` only when running as root in a container). Pages run with JavaScript disabled and every network request
  blocked, so a document can only render what the server put in it. No browser → `503 PDF_UNAVAILABLE`; the HTML form always works.
  Arabic needs an Arabic-capable font on the host (Windows and most Linux desktops have one).
* Totals never mix currencies: client balances and original-currency figures are shown per currency.

## Background jobs

A `jobs` table in SQLite is the queue (no Redis). `JobQueueService` offers `enqueue` (with optional `dedupeKey`, `runAt`, `maxAttempts`),
`claimNext`, `recoverStale`, `runOnce` and `drain`; the claim is one atomic `UPDATE … RETURNING`, so two workers can never take the same job.

* **Retries:** exponential backoff (30 s, 1 m, 2 m … capped at 1 h); after `maxAttempts` the job stays `FAILED` as a dead letter for 30 days.
* **Crash safety:** a job locked longer than `JOB_LOCK_TIMEOUT_SECONDS` is returned to the queue (or failed if out of attempts). Handlers must be
  **idempotent** — delivery is at-least-once.
* **Tenancy:** an office job runs inside that office's tenant context; system jobs run outside any.
* **Where it runs:** inside the API process by default; `JOB_WORKER=false` + `npm run worker` runs it as a separate process. Off under tests.
* **Jobs today:**
  * `task.due-soon` / `task.overdue` — queued when a task is created or its due date changes; the job re-reads the task and does nothing if it was
    completed, cancelled or re-dated, so stale jobs are harmless. Overdue also tells the person who set the task.
  * `system.cleanup` (daily) — removes finished jobs (7 d), failed jobs (30 d), long-dead login sessions and orphaned upload temp files. Never touches business or audit data.
  * `system.backup` (daily, only when configured) — see below.

## Backup and restore

`npm run backup -- create | verify <file> | restore <file> [--overwrite]` (`src/infrastructure/backup/backup.ts`). One `.cpbak` file holds a consistent
snapshot of the SQLite database (online backup, safe while the API runs) and every stored document, encrypted with **AES-256-GCM** (key from
`BACKUP_PASSPHRASE` via scrypt). A manifest records the SHA-256 of every file and the row count of every table.

* Restore decrypts to a staging area, checks the checksums, runs SQLite `integrity_check` / `foreign_key_check`, compares row counts to the manifest,
  and only then swaps the data in. A wrong passphrase, a flipped bit or truncation changes nothing. Existing data is never replaced without `--overwrite`,
  and then it is kept as `*.pre-restore-<time>`. Stop the API and worker before restoring.
* Set `BACKUP_DIR` + `BACKUP_PASSPHRASE` to run a nightly backup in the worker; the newest `BACKUP_KEEP` (default 14) are kept.
* **Without the passphrase a backup cannot be opened.** Store it somewhere other than the server. Copy `BACKUP_DIR` off the machine too — a backup on the same disk is not a backup.
* Tested by performing real restores and booting the application on the restored copy (`test/backup.test.ts`).

## Security review (Phase 6)

`GET /audit-logs` (`audit.view`) is read-only, office-scoped and filterable by action, entity, actor and time; the database also refuses updates and deletes.
`test/security.api.test.ts` enumerates every registered route and proves:

* every route is `@Public`, `@Authenticated` or `@RequirePermissions` — never none, never contradictory; the public set is exactly login, refresh, health and the signed-download link;
* "any member" routes are an explicit list of reads and the caller's own account; every other state-changing route needs a permission;
* every protected route answers 401 with no/forged/expired/alg-none/tampered tokens (and never accepts a token from a cookie or the URL), 403 for a member with no permissions or the wrong ones, and removing a permission takes effect on the next request;
* hardening headers, CORS only for configured origins, no stack/path/SQL in errors, oversized bodies rejected, login throttled, no user-enumeration difference;
* no password/token hash or storage path in any response, no credentials in the audit trail; unsafe raw SQL only in two reviewed files with bound values; no `eval`/shell access.

The review found and fixed: oversized or malformed request bodies were reported as `500` instead of `413`/`400`; the upload library `multer` had a known
denial-of-service advisory (pinned to a fixed version through `overrides` in the root `package.json`). `npm audit --omit=dev` still lists moderate advisories
in `exceljs`' dependencies (`uuid`, `minimatch`); the vulnerable code paths (`uuid` with a caller-supplied buffer, glob patterns from users) are not used.
Re-check before each release.

## Search

`contains` in Prisma/SQLite does not escape `%` and `_`, so all free-text search goes through
`searchIds()` (`src/common/search.ts`), which uses `instr()` with bound parameters: literal matching,
case-insensitive for ASCII, injection-safe. Use it for every new searchable list.

Business rules worth knowing: you can only grant permissions you hold (no privilege escalation);
system roles are read-only and their codes reserved; an office always keeps one active Owner; you
cannot deactivate yourself; a shared user account's profile can't be rewritten by one office; the
base currency can't be changed after creation.

## Creating an office

There is no self-registration endpoint (not in the spec). The operator provisions offices:

```bash
CLEARPORT_OWNER_PASSWORD='a-strong-password' npm run tenant:create -w backend -- \
  --name "Beirut Clearance Co" --slug beirut-clearance \
  --owner-email owner@example.com --owner-first Layla --owner-last Haddad
```

On Windows, `runner.bat` does this automatically for a brand-new database (demo office `Demo Office`, owner
`owner@demo.local` unless `-OwnerEmail`/`-OwnerPassword` are given). The command seeds reference data if missing, then creates the office, the main branch, the per-tenant
defaults (workflows, document requirements, categories, chart of accounts, cashboxes) and the Owner.

## Conventions for the next modules

* Controller declares its access (`@RequirePermissions`), validates with `ZodPipe`, stays thin.
* Services use `TenantDbService.client` for tenant data; write an audit entry for sensitive changes.
* Throw `DomainError` helpers (`notFound`, `conflict`, ...) with a stable code; database trigger
  failures are translated to `409 BUSINESS_RULE_VIOLATION` by the exception filter.
* Return `paginated(items, query, total)` for lists; use `orderBy()` with an allow-list for sorting.
* Cross-tenant tests (`test/tenancy.api.test.ts`) must be extended for every new resource.

## Known gaps

* Mistakenly added shipments, containers and goods cannot be deleted yet.
* Advance (unallocated) invoice allocation, and a Viewer role that can see accounting and reports.
* Segregation of duties on expense approval.
* Condition evaluation for document requirements.
* Malware scanning of uploads.
* Periodic foreign-exchange revaluation.
