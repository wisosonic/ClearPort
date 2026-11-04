# ClearPort

Customs brokerage office management for Lebanese clearance offices: clients, clearance files with
shipments, containers and goods, document checklists, tasks, multi-currency invoicing, payments and
expenses, a double-entry ledger, reports, and encrypted backups. Multi-tenant, English and Arabic (RTL).

Product and technical direction: [ClearPort_Project_Specification.md](ClearPort_Project_Specification.md).

## Current state

| Part | Status |
|---|---|
| **Backend** (NestJS + Prisma + SQLite) | Phases 1–6 complete, 516 tests. Auth, multi-tenancy, RBAC, users/roles/branches/settings, CRM, clearance files, documents, workflow, tasks, finance and accounting, dashboard, reports, Excel/CSV/PDF export, printable invoices and statements, background jobs, backup/restore, audit log, security review. |
| **Frontend** (React + Vite) | 233 tests. Sign-in (including office selection), app shell with permission-aware navigation, English/Arabic with RTL, dashboard, clients (list, create, details, contacts, files, balance and statement), the tasks page, the office-wide shipments, documents, invoices, payments and expenses lists, reports with Excel/CSV/PDF export, accounting (journal, trial balance, chart of accounts, cash and bank, exchange rates), users and roles, settings (office, branches, tax, financial categories), and the clearance-file workspace: list, create form, file page with stage moves, close/reopen, assignment, editing, shipments with containers and goods, documents (checklist, upload, review), tasks, invoices (drafts, issue, cancel), payments (record, apply, reverse), expenses (record, approve, pay), activity and stage history. Every section of the menu now has a screen. |

Architecture and API notes: [docs/architecture.md](docs/architecture.md) (backend) and
[docs/frontend.md](docs/frontend.md). Database: [docs/database.md](docs/database.md).

## Requirements

- Node.js 22+ (developed on 24) and npm. **No Docker, no Redis, no database server, no S3/MinIO** —
  SQLite is a file and documents live on the local disk.
- PDF printing needs Chrome, Edge or Chromium on the machine (`CHROME_PATH` if not auto-detected).

## Quick start (Windows)

```bat
runner.bat
```

`runner.bat` checks Node, installs dependencies, creates `backend\.env` with a random JWT secret if it is
missing, applies migrations, seeds reference data, and starts the API (http://localhost:3000/api/v1) and
the web app (http://localhost:5173) **in the same terminal**, then opens the browser. On a brand-new
database it also creates a demo office and prints the sign-in details.

| Option | Effect |
|---|---|
| `-SkipInstall` | skip `npm install` (faster restarts) |
| `-NoBrowser` | do not open the browser |
| `-OwnerEmail x` | owner of the demo office (default `owner@demo.local`) |
| `-OwnerPassword y` | its password (a random one is generated and shown if omitted) |

Press **Q** in the window to stop both servers (Ctrl+C does not stop them). They also stop if either exits.

## Manual setup (any OS)

```bash
npm install
cd backend
cp .env.example .env          # then set JWT_ACCESS_SECRET to a random string of 32+ characters
npm run db:deploy             # apply migrations (use `npm run db:migrate` while developing schema changes)
npm run db:generate           # generate the Prisma client into src/generated
npm run db:seed               # permissions, system roles, currencies, document types, ports, ...
npm test                      # unit, integration and API tests (516)

# create the first office and its owner
CLEARPORT_OWNER_PASSWORD='a-strong-password' npm run tenant:create -- \
  --name "My Office" --slug my-office --owner-email me@example.com --owner-first Me --owner-last Owner
```

Then, from the repository root:

```bash
npm run start:api             # API on http://localhost:3000/api/v1
npm run dev                   # web app on http://localhost:5173 (proxies /api to the API)
npm test -w frontend          # frontend tests (233)
```

Set `VITE_API_TARGET` to point the web app at a different API address.

## Configuration (`backend/.env`)

See [backend/.env.example](backend/.env.example) for the full list. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | SQLite file, e.g. `file:./dev.db` |
| `STORAGE_ROOT` | folder for uploaded documents |
| `JWT_ACCESS_SECRET` | signing secret, 32+ random characters (required) |
| `CORS_ORIGINS` | allowed browser origins |
| `BACKUP_DIR`, `BACKUP_PASSPHRASE`, `BACKUP_KEEP` | enable the nightly encrypted backup and set how many to keep |
| `JOB_WORKER` | `false` to run background jobs in a separate process (`npm run worker`) |
| `CHROME_PATH` | browser used for PDF printing, if not auto-detected |

## Operations

- **Offices:** there is no self-registration; the operator creates offices with `npm run tenant:create`.
  Per-tenant defaults (workflows, document requirements, financial categories, chart of accounts, USD/LBP
  cashboxes) are created by `provisionTenantDefaults()`
  ([backend/src/seed/tenant-defaults.ts](backend/src/seed/tenant-defaults.ts)).
- **Background jobs** (task reminders, housekeeping, nightly backup) run inside the API by default.
- **Backups:** set `BACKUP_DIR` and `BACKUP_PASSPHRASE` for a nightly encrypted backup, or run
  `npm run backup -- create`; verify with `npm run backup -- verify <file>` and restore with
  `npm run backup -- restore <file>`.

## Repository layout

```
runner.bat           one-command install and run (Windows)
backend/
  prisma/            schema.prisma, migrations/ (incl. hand-written integrity triggers), seed.ts
  src/common/        money (decimal strings), numbering, errors, envelope, pagination, Zod pipe
  src/database/      Prisma client factory, tenant context + tenant-scoped client
  src/modules/       auth, users, roles, branches, tenants, clients (+parties), clearance-files (+shipments),
                     documents, workflow, tasks, finance, reports, audit, health
  src/seed/          reference data and per-tenant defaults
  src/infrastructure/ storage, pdf, queue (jobs, worker, housekeeping), backup
  src/cli/           create-tenant, worker, backup
  test/              vitest: DB rules, tenant isolation, numbering, money, security and API tests
frontend/
  src/app/           router, layout, navigation, providers
  src/features/      auth, dashboard, clearance-files, clients
  src/components/ui/ shared UI primitives
  src/lib/           API client, permissions, formatting
  src/i18n/          English and Arabic translations
  src/test/          vitest + Testing Library
docs/                architecture.md, database.md, frontend.md
infrastructure/      nginx/, scripts/ (placeholders)
```

## Key decisions

See section 23 of the specification, plus [docs/database.md](docs/database.md). Deviations from the
original spec text, made at the owner's request: SQLite instead of PostgreSQL (so no RLS; tenant isolation
= composite FKs + a tenant-scoped data-access layer), local filesystem instead of S3/MinIO, SQLite job
queue instead of Redis/BullMQ, no Docker.
