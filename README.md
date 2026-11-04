# ClearPort

Customs brokerage office management for Lebanese clearance offices. Product and technical
direction: [ClearPort_Project_Specification.md](ClearPort_Project_Specification.md).

**Current state:** Phase 1 backend foundation — database schema, migrations, integrity rules, seeds,
and a NestJS API with authentication, multi-tenant isolation, RBAC, users, roles, branches and office
settings, the CRM (clients, contacts, business parties, balance and statement) and clearance files (numbering, assignment, shipments, containers, goods, search, timeline) — plus documents, workflow, tasks, and the finance module (multi-currency expenses, invoices with tax and discounts, payments, cross-currency allocation, a double-entry ledger, file profitability and financial reports) — plus the dashboard, operational reports, Excel/CSV/PDF export, printable invoices and statements (English/Arabic), a background job queue (task reminders), encrypted backup and restore, and an audit-log endpoint with a security review — 515 tests, including the full end-to-end MVP scenario. No UI yet.
See [docs/architecture.md](docs/architecture.md).

## Requirements

- Node.js 22+ (developed on 24) and npm. **No Docker, no Redis, no database server, no S3/MinIO** —
  SQLite is a file, documents live on the local disk.

## Setup

```bash
npm install
cd backend
cp .env.example .env          # DATABASE_URL, STORAGE_ROOT
npx prisma migrate deploy     # apply migrations (use 
pm run db:migrate` while developing schema changes)
npm run db:generate           # generate the Prisma client into src/generated
npm run db:seed               # permissions, system roles, currencies, document types, ports, ...
npm test                      # unit, integration and API tests (515)

# create the first office + owner, then run the API on http://localhost:3000/api/v1
CLEARPORT_OWNER_PASSWORD='a-strong-password' npm run tenant:create -- \
  --name "My Office" --slug my-office --owner-email me@example.com --owner-first Me --owner-last Owner
npm start
```

Background jobs run inside the API by default. Set `JOB_WORKER=false` and run 
pm run worker` to run them in a separate process.
PDF printing needs Chrome, Edge or Chromium on the machine (`CHROME_PATH` if not auto-detected).
Backups: set `BACKUP_DIR` and `BACKUP_PASSPHRASE` for a nightly encrypted backup, or run 
pm run backup -- create`; restore with 
pm run backup -- restore <file>`.

One command for everything (Windows): `.\run-app.ps1` installs dependencies, prepares the database and starts the API and the web app (`-SkipInstall` for faster restarts, `-NoBrowser`).

Frontend: 
pm run start:api` (API on :3000) and 
pm run dev` (UI on http://localhost:5173, proxies `/api` to the API; set `VITE_API_TARGET` to change). 
pm test -w frontend` runs its tests.

Edit `JWT_ACCESS_SECRET` in `.env` first (any random string of 32+ characters).

Per-tenant defaults (workflow templates, document requirements, financial categories, chart of
accounts, USD/LBP cashboxes) are created by `provisionTenantDefaults()`
([src/seed/tenant-defaults.ts](backend/src/seed/tenant-defaults.ts)) when a tenant is created.

## Repository layout

```
backend/
  prisma/            schema.prisma, migrations/ (incl. hand-written integrity triggers), seed.ts
  src/common/        money (decimal strings), numbering, errors, envelope, pagination, Zod pipe
  src/database/      Prisma client factory, tenant context + tenant-scoped client
  src/modules/       auth, users, roles, branches, tenants, clients (+parties), clearance-files (+shipments), documents, workflow, tasks, finance, audit, health
  src/seed/          reference data and per-tenant defaults
  src/infrastructure/ storage, pdf, queue (jobs, worker, housekeeping), backup
  src/cli/           create-tenant, worker, backup
  test/              vitest: DB rules, tenant isolation, numbering, money, auth + tenancy API
frontend/            React + Vite + TypeScript + Tailwind: login, app shell, dashboard, clearance-file and client lists (English/Arabic, RTL)
docs/                database.md (ERD, conventions, rules)
infrastructure/      nginx/, scripts/ (placeholders)
```

## Key decisions

See section 23 of the specification, plus [docs/database.md](docs/database.md). Notable deviations
from the original spec text, made at the owner's request: SQLite instead of PostgreSQL (so no RLS;
tenant isolation = composite FKs + a tenant-scoped data-access layer), local filesystem instead of
S3/MinIO, SQLite job queue instead of Redis/BullMQ, no Docker.
