# ClearPort — Frontend

React 19 + Vite 7 + TypeScript, Tailwind 4, React Router 7 (data router), TanStack Query 5, React Hook
Form + Zod, i18next (English and Arabic), Lucide icons, date-fns. Tests: vitest + Testing Library + jsdom.
Code lives in [`frontend/`](../frontend); the API it talks to is described in [architecture.md](architecture.md).

## Running

```bash
npm run start:api      # API on :3000 (from the repository root)
npm run dev            # web app on http://localhost:5173
npm test -w frontend   # 176 tests
npm run build -w frontend   # type-check + production build
```

On Windows, `runner.bat` does everything, including installing dependencies. The dev server proxies
`/api` to `http://localhost:3000`; set `VITE_API_TARGET` to change it.

## Structure

```
src/app/            App, router, navigation (nav.ts), dashboard layout, providers
src/features/       one folder per area: auth, dashboard, clearance-files, clients  (pages/ inside)
src/components/ui/  shared primitives (buttons, inputs, tables, states)
src/lib/            api-client, permissions, format, cn
src/i18n/           en/common.json, ar/common.json, language setup
src/hooks/          small shared hooks
src/test/           setup, API client, foundations and app tests
```

## How it works

**API client** ([api-client.ts](../frontend/src/lib/api-client.ts)). The only code that calls the backend. It
unwraps the `{ success, data, meta }` envelope, throws `ApiError` (status, code, message, details) on failure,
and adds the bearer token. The access token is kept **in memory only**; the refresh token is in `localStorage`
so a reload or second tab stays signed in. When a request gets 401 the client refreshes once (single-flight:
many failing requests trigger one refresh) and retries; if the session cannot be refreshed the user is sent to
the login page. Network trouble never signs the user out.

**Authentication** ([auth.tsx](../frontend/src/features/auth/auth.tsx)). Login by e-mail and password; when
the account belongs to several offices the form asks which one. The session is restored from the stored
refresh token on load. `GET /auth/me` provides the user, office and permission list. Sign-out revokes the
session and clears the stored token. Visitors are returned to the page they asked for after signing in.

**Permissions.** `can()` / `canAny()` ([permissions.ts](../frontend/src/lib/permissions.ts)) decide what is
*shown*: navigation links, dashboard blocks, buttons. Routes are guarded too, so a typed address without
permission shows "no access" without calling the API. The API remains the real enforcement point.

**Navigation** ([nav.ts](../frontend/src/app/nav.ts)). One list drives the sidebar and the routes. Each item
has the permissions that reveal it and a `built` flag; sections not built yet render a "being built" placeholder.

**Language and direction.** English and Arabic; the choice is remembered, and `<html lang dir>` switches to
`ar`/`rtl`. Use only logical Tailwind utilities (`ms-`, `me-`, `ps-`, `pe-`, `start-`, `end-`, `text-start`,
`border-s`, `rounded-s` …), never `ml-`/`mr-`/`left-`/`right-`: a test fails the build if physical ones appear.
Translation keys must exist in both languages (also tested). Numbers and money use Latin digits and `1,234.50`
grouping in both languages; Arabic dates use Lebanese month names.

**Money** arrives as exact decimal strings and is only formatted for display, never added up in the browser.
Amounts are shown per currency (e.g. `1,000.00 USD · 89,500,000 LBP`), never summed across currencies.

## Screens

| Route | Status |
|---|---|
| `/login` | done (wrong password, office selection) |
| `/` Dashboard | done: file counts, my tasks, finance block only with finance permissions |
| `/files` Clearance files | list with search, filters and paging; **New file** button with the create permission |
| `/files/new` | create form: client search, type, priority, branch, arrival date, customs reference, notes |
| `/files/:id` | file page: stage panel, assignment, tabs Overview (details, edit, counts), Shipments, Documents, Tasks, Invoices, Payments, Expenses, Activity, Stage history |
| `/clients` Clients | list with search and paging; **New client** for `clients.manage` |
| `/clients/new`, `/clients/:id` | create form; client page with tabs Details (edit, deactivate), Contacts, Files, Account |
| `/invoices`, `/payments` | every invoice / payment in the office with filters (status, type, unpaid/overdue, unapplied, dates, search); rows link to the client and the file, where changes are made |
| `/reports` Reports | one page for clearance files, client balances, expenses, revenue and employee performance; filters, totals, export |
| `/accounting` Accounting | tabs Journal (filters, lines, manual entries, reversal) and Trial balance |
| `/tasks` Tasks | the office's tasks (members see theirs by default), filters: open/finished, mine, overdue |
| shipments, documents, expenses, users, settings | placeholder |

## Clearance file workspace

* **Create** (`NewFilePage`): the server generates the file number and picks the workflow; the form only sends
  what the person filled in, and the server's refusal (for example an inactive client) is shown as-is.
* **Stage panel** (`StagePanel`): lists the moves the workflow allows (`GET /transitions`). A move that is not
  allowed is disabled and the reasons are listed (missing documents, open tasks, approval). A move that needs a
  reason asks for it first. Once the file is at its final stage, people with `clearance_files.close` see the
  closure check; unpaid invoices need an explicit acknowledgement. Closed files can be reopened with a reason.
* **Assignment** (`AssignControl`): with `clearance_files.assign`, assign to yourself or unassign; picking another
  employee needs `users.manage` because the user list is restricted.
* **Edit**: priority, expected arrival, customs reference and notes (the client and branch are not editable here).
  Closed and cancelled files are read-only.
* The activity timeline texts and some blocker messages are written by the server in English; known blocker
  codes are translated, the rest show the server text.

### Shipments tab

Shipments with their containers and goods lines (`components/shipments/`). Add and edit need `clearance_files.update`
and a file that is not closed or cancelled; otherwise the tab is read-only and says why.

* **Containers:** the server enforces ISO 6346. A number that is not in ISO format is refused with a message; the
  form then offers an explicit "record anyway" checkbox. A wrong check digit is always refused (it is a typo). When
  editing, the number is only sent if it changed, so an already-recorded non-standard number does not need re-confirming.
* **Goods:** with both quantity and unit price the server computes the line total, so the field is disabled; a price needs a currency.
* **Numbers** (weights, quantities, prices) are typed as plain decimals and sent as strings; they are never converted to floats.
* Not yet on this tab: shipping agent / freight forwarder pickers (shown read-only), HS code picker (no codes are seeded), deleting entries.

### Documents tab

Shown only with `documents.view` (`components/documents/`).

* **Checklist** (`GET /clearance-files/:id/document-requirements`): each required type with its state (missing, uploaded,
  approved, rejected) and the stage it is needed before. This is the same data that blocks stage moves in the stage panel, and
  uploading refreshes both. A missing item has an **Upload** button that pre-selects its type.
* **Upload** (`documents.upload`): type + file + notes, sent as multipart. The server checks the real file content against its
  extension and the size limit; its message is shown when a file is refused. A new version of an existing document is uploaded from its row.
* **Review** (`documents.review`): approve with one click; reject needs a reason; return to review. **Void** (`documents.delete`)
  asks for confirmation and keeps the file and its history on the server.
* **Download:** the API needs the bearer token, so the file is fetched with it and saved from memory under its own name (Arabic names
  included). It is not a plain link. `api.upload()` and `download()` in `lib/api-client.ts` do this, with the same token refresh as other calls.
* Closed and cancelled files are read-only except for downloading.

### Tasks (`features/tasks/`)

One list and one form, used on the **Tasks** tab of a file (`/clearance-files/:id/tasks`) and on the `/tasks` page.

* **Who can do what** follows the API: anyone with `tasks.view` can start, complete and reopen **their own** tasks; `tasks.manage` can also
  create, edit, cancel and work on anyone's. The buttons are hidden when the API would refuse; if it refuses anyway, its message appears under the task.
* **Assignee:** a new task goes to the person creating it. Choosing someone else needs `users.manage` (the user list is restricted).
* **Due date** is a whole day in the user's own time zone and falls due at the **end** of that day (`dueToIso` / `isoToLocalDay`). Doing this in UTC would show
  the next day in Lebanon; the tests run in several time zones to guard it. The Overdue badge comes from the server (`isOverdue`).
* Changing a task refreshes what depends on it: open tasks block stage moves and closing a file, and show on the dashboard and in the file summary.
* Tasks on a closed or cancelled file are read-only.

### Invoices (`features/clearance-files/components/invoices/`)

The **Invoices** tab (needs `invoices.view`) lists the file's invoices; a row expands to show lines, totals and actions.

* **Lifecycle:** a *draft* has no number and no accounting and can be edited or discarded. *Issue* gives it the next number, freezes it and posts it to the ledger.
  An issued invoice cannot be edited; it can only be cancelled (needs `invoices.issue` and a reason), and the API refuses while payments are applied to it.
* **Lines:** a *service fee* (description, a fee category, quantity, unit price) or an *expense re-billed at cost*, picked from the file's approved, not-yet-billed
  expenses in the same currency (needs `expenses.view`). Expenses in pass-through categories can only be billed this way. An **advance** invoice is a request for funds:
  no categories, no discount, no re-billing, and nothing is booked until money arrives.
* **Totals and tax** are computed by the API on save and shown from its response; the form never does money arithmetic.
* Issuing uses the exchange rate in force; if a foreign-currency invoice has no rate the API's message is shown.

### Payments (`features/clearance-files/components/payments/`)

The **Payments** tab (needs `payments.view`) lists the payments recorded against the file; a row expands to show what was applied and the actions.

* **Record** (needs `payments.create`): a *payment* (money for invoices), an *advance* (money before an invoice, held for the client) or a *refund* (pays back credit the
  client holds; the API refuses more than the held credit). The money goes to a cash or bank account **in the payment's currency**, which is chosen automatically when there is only one.
* **Apply to invoices:** shows the file's issued invoices with something outstanding (advance invoices are not payable; the API explains why). When the invoice is in another
  currency than the payment, the amount credited to the invoice can be typed or left empty to convert at the current rate.
* **Reverse** an allocation or **cancel** a payment, each with a reason. A payment can only be cancelled when none of its allocations is live.
* The payment methods are a fixed list in the UI (cash, bank transfer, cheque, card, other) because the API has no endpoint to list them.
* Everything the payment touches is refreshed: the invoices (paid and outstanding are derived), the closure check and the file summary.

### Expenses (`features/clearance-files/components/expenses/`)

The **Expenses** tab (needs `expenses.view`) lists the costs recorded against the file, each row with the actions its state allows.

* **Record / edit** (`expenses.create`): category, description, amount, currency, date. Only cost categories are offered (fees the office earns are not costs). A *pass-through*
  category is paid for the client and can later be re-billed at cost on an invoice; an *office* category is the office's own cost. Only a **draft** can be edited.
* **Approve** (`expenses.approve`) books the expense. Choose the account it was paid from, or leave it unpaid to record a payable; **Mark as paid** settles a payable later.
  Accounts are those in the expense's currency, and picking one needs `payments.view`.
* **Cancel** needs a reason; an expense already on an invoice cannot be cancelled until that invoice is (the API says so).
* There is no vendor field: the API has no endpoint to list vendors yet.

### Clients (`features/clients/`)

* **Create / edit** (`clients.manage`): one form for both. The code is generated (CLT-00001) unless typed, and cannot be changed afterwards. Empty optional fields are sent as
  empty so the API clears them. Deactivating a client keeps their history; the list hides inactive clients by default.
* **Contacts:** add, edit, remove (with confirmation); exactly one is primary, and making another primary moves the mark.
* **Files** (needs `clearance_files.view`) and **Account** (needs `invoices.view` and `payments.view`, as the API requires): the balance is shown **per currency** and is never summed
  across currencies; the statement can be filtered by currency and dates. A positive net balance means the client owes the office.

### Reports (`features/reports/`)

Every report arrives from the API as one uniform table (`meta.columns`, rows, optional totals), so one page renders them all and each report is just an entry in `REPORTS`
with the permissions it needs (the same ones the API checks) and the filters it understands. A user sees only the reports they may open.

* **Money:** base-currency reports show plain amounts under a header that names the currency, e.g. "Revenue (USD)"; rows that carry their own `currency` (client balances,
  expense amounts) show it. Currencies are never added together: client balances show **totals per currency** underneath.
* **Export** (needs `reports.export`): Excel, CSV or PDF of the current report with the same filters, in the interface language; the API audits every export and re-checks the
  permissions of the report being exported.
* Profitability and the financial summary are available from the API and the export, but have no table on this page yet; the trial balance is planned for the accounting screen.

### Accounting (`features/accounting/`)

Needs `accounting.view`; posting and reversing need `accounting.post`.

* **Journal:** every entry with its lines in transaction and base currency. Filter by status, source (manual, invoice, payment, expense, reversal), dates and text.
* **Manual entry:** two or more lines, each a debit **or** a credit on an active account, with a currency. When all lines share one currency the form shows the running difference; with mixed
  currencies the API checks balance in the base currency and its message is shown. Entries are posted at once.
* **Reverse:** only a *posted manual* entry, with a reason. Entries created by an invoice, payment or expense say so and must be undone by cancelling or reversing that record, which keeps
  the record and the ledger in agreement.
* **Trial balance:** per account debit, credit and balance in the base currency, as of a date, with a clear warning if the ledger is ever out of balance.
* Still to come on this screen: chart of accounts, cash accounts, exchange rates.

## Adding a screen

1. Create `src/features/<area>/pages/<Name>Page.tsx`; fetch with `api.get` / `api.list` inside TanStack Query.
2. Register it in `router.tsx` with `guard([...permissions], <Page />)` and set `built: true` in `nav.ts`.
3. Add every visible string to **both** `en/common.json` and `ar/common.json`.
4. Use logical spacing classes only; format money and dates with `lib/format.ts`.
5. Add a test in `src/test/` that mocks `fetch` (see `app.test.tsx`).

## Next

The remaining office-wide lists (shipments, documents, expenses), the rest of accounting (chart of accounts, cash accounts, exchange rates); users and settings; code-splitting (the bundle is about 611 kB).
