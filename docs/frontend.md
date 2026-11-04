# ClearPort — Frontend

React 19 + Vite 7 + TypeScript, Tailwind 4, React Router 7 (data router), TanStack Query 5, React Hook
Form + Zod, i18next (English and Arabic), Lucide icons, date-fns. Tests: vitest + Testing Library + jsdom.
Code lives in [`frontend/`](../frontend); the API it talks to is described in [architecture.md](architecture.md).

## Running

```bash
npm run start:api      # API on :3000 (from the repository root)
npm run dev            # web app on http://localhost:5173
npm test -w frontend   # 72 tests
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
| `/files/:id` | file page: stage panel, assignment, tabs Overview (details, edit, counts), Shipments, Documents, Activity, Stage history |
| `/clients` Clients | list with search and paging |
| shipments, documents, tasks, invoices, payments, expenses, accounting, reports, users, settings | placeholder |

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

## Adding a screen

1. Create `src/features/<area>/pages/<Name>Page.tsx`; fetch with `api.get` / `api.list` inside TanStack Query.
2. Register it in `router.tsx` with `guard([...permissions], <Page />)` and set `built: true` in `nav.ts`.
3. Add every visible string to **both** `en/common.json` and `ar/common.json`.
4. Use logical spacing classes only; format money and dates with `lib/format.ts`.
5. Add a test in `src/test/` that mocks `fetch` (see `app.test.tsx`).

## Next

The remaining tabs of the file page (tasks; invoices and payments; expenses); client details and forms; tasks and
documents; finance screens; reports, users and settings; code-splitting (the bundle is about 611 kB).
