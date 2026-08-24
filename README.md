# Yugaantar Finance & Operations Dashboard

Role-based platform for Yugaantar '26: budget and line items, reimbursements, vendor
payments, income, work tickets, flags, notifications and audit. Spec:
[`system_PRD.md`](./system_PRD.md), which is binding — sections 18–21 are the
engineering handoff.

## Status

**M1–M6 complete.** Everything in the PRD's MVP scope (section 15) is built and
verified against a live Postgres 18 database and the running app. Section 15's v1.1
list is deliberately not built — see [What is not built](#what-is-not-built).

| Milestone | Delivers | State |
|---|---|---|
| M1 Foundation | Schema, `can()`, audit service, attachments, app shell, sign-in (Clerk *or* emailed links) | ✅ |
| M2 Budget | Fest total, allocations, transfers, line items, documents, the `v_*` views, dashboards, budget review, F13/F14 | ✅ |
| M3 Reimbursements | Full 7.2 state machine, the three queues, F1–F6, comments, timelines, email | ✅ |
| M4 Vendors & income | 7.3 state machine with milestones, exposure, F8/F9/F12, income ledger and tranches, cash position | ✅ |
| M5 Work tickets | 7.7 state machine, board views, watchers, links, similar-ticket lookup, workload, SLA cron | ✅ |
| M6 Close-out | Exports 12.1–12.7 in CSV/XLSX/print, bulk approve, payment batch, audit screens, daily digest | ✅ |

### Definition of done (PRD 21.3)

| Requirement | Where it is proven |
|---|---|
| Every route handler calls `can()`; each role gets 403 on every endpoint it must not use | `tests/api/permissions.test.ts` — the 5.1 matrix, run against the real handlers |
| State machines cover every `from × action`, including segregation cases | `tests/unit/state-machines.test.ts` |
| The five numbers match a hand-computed fixture after submit → endorse → approve → pay, plus a vendor advance and a balance adjustment | `tests/db/budget-arithmetic.test.ts` — the 19.6 fixture |
| No `number` arithmetic on rupees; `money.ts` is the only formatter | `tests/unit/money.test.ts`; `lib/money.ts` |
| Every write produces an audit event with `before`/`after`; `audit_events` takes no UPDATE or DELETE | `db/migrations/0003_append_only_audit.sql` (trigger + revoked grants), `tests/db/budget-guards.test.ts` |
| Attachments are never served from a public URL | `lib/services/attachments.ts`; `tests/api/flows.test.ts` |
| `pnpm test`, `pnpm lint`, `pnpm typecheck` pass; `pnpm db:seed` produces a working deployment | 410 tests across 16 files |

## Setup

Requires Node 22+, pnpm, and a Postgres 16+ database.

```bash
pnpm install
cp .env.example .env.local           # DATABASE_URL below works out of the box
docker run -d --name yugantar-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=yugantar \
  -p 5433:5432 postgres:18-alpine
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`DATABASE_URL=postgres://postgres:dev@localhost:5433/yugantar`

Every external service is optional and the app degrades honestly without it — see
[Integrations](#integrations). With none of them configured you get a working app
whose sign-in links are written to the server log instead of being emailed.

### First run

`pnpm db:seed` does not create sample data. It creates the smallest thing that can
exist: the fest, the Finance and Core departments (the schema permits exactly one of
each, so they cannot be made from the admin screen), the PRD 21.1 expense types, and
**one Finance HOD**, who is the platform administrator — `ajij.24bcs10103@sst.scaler.com`
unless `BOOTSTRAP_ADMIN_EMAIL` says otherwise. It is idempotent; `--reset` tears the
fest down first and refuses to run in production.

From there everything is done in the app, in this order:

1. **Sign in.** Open `/sign-in`, enter that address, follow the emailed link. Without
   `RESEND_API_KEY` the link is printed to the server log — that is how a fresh
   deployment gets its first administrator in.
2. **Set the total budget** on `/admin`. It starts at zero on purpose, so the first
   figure is a deliberate act rather than an inherited one.
3. **Add departments** on `/admin`. They start with nothing allocated.
4. **Allocate** on `/budget` — money only ever moves by transfer, so every rupee that
   changes hands carries a reason and an audit row.
5. **Invite people** on `/admin`. Each invitation emails a sign-in link; following it
   is what turns INVITED into ACTIVE.

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm build` · `pnpm start` | Production build and server |
| `pnpm test` | Vitest — unit, database and route-handler tests against `DATABASE_URL` |
| `pnpm typecheck` · `pnpm lint` | `tsc --noEmit` · ESLint |
| `pnpm db:generate` | Regenerate a migration after editing `db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Bootstrap the fest and its first administrator (idempotent; `--reset` starts over) |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm env:check` | Which API keys are set, what they unlock, what is missing |
| `pnpm r2:check` | Round-trip the real R2 bucket: presign, upload, read back, delete |

## Architecture

Follows PRD 18.2 exactly. The ten rules, and where each one lives:

| Rule | Where |
|---|---|
| 1. One authorization function | `lib/authz.ts` — `can` / `assertCan` / `canFestWide`. Route handlers and the UI use the same function |
| 2. State machines as data | `lib/state-machines/{reimbursement,vendor,ticket,line-item}.ts` |
| 3. Derived numbers from SQL | `db/migrations/0001_views.sql`, read through `lib/queries/budget.ts` |
| 4. Integer paise everywhere | `lib/money.ts` is the only place amounts are formatted |
| 5. Every write is a service call | `lib/services/*` — one transaction, audit event inside it |
| 6. Segregation of duties in `can` | `lib/authz.ts`, plus `satisfiesActorConstraints` for "who exactly" |
| 7. Soft delete; append-only audit | `deleted_at` / `removed_at`; `0003_append_only_audit.sql` |
| 8. Human IDs from per-fest sequences | `lib/human-id.ts`, allocated in the creating transaction |
| 9. Idempotency | `Idempotency-Key` handled in `lib/api.ts`'s `route()` wrapper |
| 10. Fest scoping | Every query takes `fest_id` from the session; no endpoint accepts one |

```
app/
  (auth)/                       sign-in (Clerk or a link) and the link callback
  (app)/                        dashboard requests tickets budget vendors income
                                queues flags notifications close-out audit admin
  api/v1/…                      route handlers: parse → can() → service → respond
proxy.ts                        security headers (CSP) + Clerk session resolution
lib/
  authz.ts  entities.ts         permissions; (type, id) → the resource `can` needs
  api.ts                        route wrapper: session, params, idempotency, errors
  state-machines/  services/    transition tables; all writes, one transaction each
  flags/  queries/              F1–F14; the five numbers, queues and dashboards
  money.ts  human-id.ts         paise and ₹; per-fest sequences
  storage.ts  email.tsx         R2 (SigV4, no SDK) or local disk; Resend
  auth.ts  session.ts           sign-in links and sessions; who the caller is
  env.ts                        reading config, where blank means unset
  clerk.ts  rate-limit.ts       identity linking and invitations; fixed-window limits
  xlsx.ts  test-support.ts      a minimal XLSX writer; the audit-guard escape hatch
emails/                         the notification template (light, table-based HTML)
jobs/                           cron logic, called by app/api/v1/cron/*
db/                             schema, migrations (incl. the 19.4 views), seed
tests/  unit/ db/ api/          state machines, money, flags · services + SQL · handlers
```

Three deliberate deviations from PRD 18.1, each noted at the point of use:

- **Database driver.** `postgres-js` rather than the Neon HTTP driver, because rule 5
  ("every write is one transaction") needs interactive transactions, which the HTTP
  driver does not support. Works unchanged against a Neon pooled connection string.
- **Sign-in without Clerk.** PRD 13 names Google Workspace via Clerk, and that is
  still the path wherever Clerk is configured. Emailed one-time links are the
  alternative when it is not, so a deployment is usable before those keys exist —
  same passwordless shape, same domain restriction, same invitation-only rule. See
  [Signing in](#signing-in).
- **XLSX and PDF.** `lib/xlsx.ts` writes the ZIP and SpreadsheetML directly rather
  than pulling a spreadsheet library into a serverless bundle; it is unit-tested by
  reading the bytes back (`tests/unit/xlsx.test.ts`). PRD 12's PDF outputs are served
  as a light-themed, A4-styled HTML page that the browser prints — the same artefact
  without a rendering engine in the bundle.

## Integrations

Each degrades to something usable rather than failing, so the app runs with none of
them configured. All are wired and ready for credentials.

| Service | Configured | Not configured |
|---|---|---|
| **Clerk** (`CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`) | Google sign-in restricted to `ALLOWED_EMAIL_DOMAIN`; `POST /webhooks/clerk` links a Clerk account to the INVITED row with that email — unknown emails are refused | A one-time link emailed to an already-invited address (`lib/auth.ts`), backed by a server-side session. See [Signing in](#signing-in) |
| **Cloudflare R2** (`R2_*`) | Private bucket; presigned PUT for upload, presigned GET for reads, both 15 minutes. SigV4 signed in `lib/storage.ts` — no AWS SDK. See [Setting up R2](#setting-up-r2) | Files go to `./.uploads` with HMAC-signed URLs of the same shape and expiry. `UPLOAD_URL_SECRET` is required for this path in production |
| **Resend** (`RESEND_API_KEY`, `EMAIL_FROM`) | Notifications are written in the same transaction as the write that caused them, then sent after the response commits (`after()`); failures retry on the `/cron/outbox` sweep | Rows stay unsent and the body is logged. The in-app inbox works either way |
| **Anthropic** (`ANTHROPIC_API_KEY`) | — | Receipt OCR and the model-based flags are v1.1 (PRD 15). `attachments.ocr_json` exists, so adding them needs no migration |

### Signing in

Two providers, never both offered at once, and the app is identical downstream of
either — `lib/session.ts` resolves both to a row in `users` with a role and a
department, and authorization runs on that.

Where Clerk is configured it wins, exactly as PRD 18.1 specifies. Where it is not,
sign-in is a one-time link (`lib/auth.ts`). What makes that safe:

- **An invitation is the gate.** A link is only ever issued to an address that already
  has a `users` row. Nobody signs themselves up — the same rule the Clerk webhook
  enforces.
- **Only hashes are stored.** The token in the inbox is the secret; the database holds
  its SHA-256. A database dump grants nobody a login.
- **One use, fifteen minutes.** Consumption is a conditional `UPDATE`, so the database
  settles the race when a link is clicked twice.
- **No account enumeration.** The endpoint answers identically for an unknown address,
  a disabled one and a real one, and is rate limited per address *and* per caller — so
  one inbox cannot be flooded from many hosts, nor many addresses raked from one.
- **Sessions are rows, not claims.** Disabling someone has to take effect now, and a
  stateless token cannot be withdrawn before it expires. Signing out revokes the row,
  so a copied cookie dies with it.

`tests/api/auth.test.ts` covers each of those as a thing that must *not* work.

### API keys

Every key lives in **`.env.local`**, which is gitignored. Nothing is committed, and
nothing is read from anywhere else in development.

```bash
cp .env.example .env.local     # if you have not already
$EDITOR .env.local             # paste values after the `=`
pnpm env:check                 # what is set, what it unlocks, what is missing
```

`pnpm env:check` reads the files the way Next does and reports which keys landed,
which are present-but-blank, and what each missing one costs you. It never prints a
value. Restart the dev server after editing — env files are read at startup.

| Key | Where it comes from | Without it |
|---|---|---|
| `DATABASE_URL` | Neon connection string, or the local container | The app cannot start |
| `APP_URL` | The address people actually reach the app on | Emailed links point at localhost |
| `RESEND_API_KEY`, `EMAIL_FROM` | resend.com → API Keys; the from-address must be on a verified domain | Mail is logged, not sent — nobody you invite can sign in |
| `R2_*` | Cloudflare → R2 → API → Manage API tokens ([full steps](#setting-up-r2)) | Files go to `./.uploads`, lost on redeploy |
| `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | clerk.com → API Keys | Sign-in is an emailed link instead (both are fine) |
| `CRON_SECRET` | `openssl rand -hex 32` | Every `/api/v1/cron/*` returns 403 |
| `UPLOAD_URL_SECRET` | `openssl rand -hex 32` | Only needed when running **without** R2 in production |
| `ANTHROPIC_API_KEY` | Nothing yet — OCR is v1.1 | No effect |

**Blank is not the same as a value.** `.env.example` lists every optional key with
nothing after the `=`, so a copied file is full of empty strings. The app treats
blank as unset everywhere (`lib/env.ts`), which is why a half-filled `R2_*` block
falls back to local disk rather than failing strangely.

**Only keep one env file.** Next reads `.env`, then `.env.local` on top, so a key in
both is a silent override — `env:check` warns when it finds one. Use `.env.local`.

**In production the files are not used at all.** On Vercel, keys go in Project →
Settings → Environment Variables, and a **redeploy** is what picks up a change.
`NEXT_PUBLIC_`-prefixed values are baked into the client bundle at build time, so
changing one needs a rebuild, not just a restart. `env:check` also flags the things
that are fine locally and wrong in production: an `APP_URL` still on localhost, the
example `CRON_SECRET`, and mail that goes nowhere.

### Setting up R2

Receipts, invoices and MoUs go to a **private** bucket, and the browser uploads to it
directly (PRD 20.2) — so the two things that actually bite are CORS and the CSP.

Most of it is done from the CLI, and the bucket's configuration lives in
[`infra/`](./infra) rather than in someone's memory of what they clicked.

**1. Create the bucket.**

```bash
npx wrangler r2 bucket create yugaantar-receipts --location apac
npx wrangler r2 bucket dev-url get yugaantar-receipts   # must say disabled
```

Public access stays off. Every file is served through a 15-minute signed URL issued
only to someone who can see the parent record (`lib/services/attachments.ts`); a
public bucket URL would bypass that entirely.

**2. Allow the app's origin in the bucket's CORS policy.** This is the step people
miss. The browser PUTs straight to `*.r2.cloudflarestorage.com`, which is a
cross-origin request with a non-safelisted `Content-Type`, so it is preflighted.

```bash
# edit infra/r2-cors.json to list every origin the app is served from
npx wrangler r2 bucket cors set yugaantar-receipts --file infra/r2-cors.json
npx wrangler r2 bucket cors list yugaantar-receipts
```

Note the file uses Cloudflare's own shape (`{ "rules": [{ "allowed": { … } }] }`),
not the S3 XML-style JSON — wrangler rejects the latter. A missing origin shows up as
an opaque "Upload failed" in the receipt form and a CORS error in the console, while
the presign call itself succeeds, which is what makes it confusing.

**3. Create S3-compatible credentials.** The only step the CLI cannot do: wrangler
has no command for R2 API tokens, and its OAuth token is not permitted to mint them.
In the dashboard: **R2 → API → Manage API tokens → Create API token**, scoped to
**Object Read & Write** on this bucket. The Access Key ID and Secret Access Key are
shown once.

```
R2_ACCOUNT_ID=<account id, shown on the R2 overview page>
R2_ACCESS_KEY_ID=<access key id>
R2_SECRET_ACCESS_KEY=<secret access key>
R2_BUCKET=yugaantar-receipts
# R2_ENDPOINT only for S3-compatible stores that are not R2 (MinIO, Supabase).
# Blank, it is derived: https://<account id>.r2.cloudflarestorage.com
```

All four must be set. Any one blank and the app quietly stays on the local-disk
backend — `r2Configured()` decides, and blank counts as unset (`lib/env.ts`).

**4. Check it.**

```bash
pnpm r2:check
```

That presigns a PUT, uploads through it, reads the object back server-side, follows a
presigned GET, confirms an unsigned request is refused, and deletes the probe object.
Worth running because the SigV4 signing is hand-rolled rather than an SDK: unit tests
can check the shape of a URL, only this checks that Cloudflare accepts it.

**Nothing to do about the CSP.** `proxy.ts` adds the bucket's origin to `connect-src`
once the four variables are set, because otherwise the Content-Security-Policy would
block the very upload CORS just allowed:

```bash
curl -sI https://your-app-domain/sign-in | grep -i content-security-policy
# … connect-src 'self' https://<account id>.r2.cloudflarestorage.com; …
```

Objects are keyed `<fest id>/<attachment id><ext>`, so a bucket listing reveals
nothing about who spent what. Retention is PRD 11's two years; nothing in the app
deletes a file belonging to a record — removal is soft, and only the nightly
`gc-attachments` job deletes objects, and only ones that never got a parent.

### Notifications

The PRD 10 recipient table is data, in `lib/services/notify-routing.ts`, so it can be
read against the spec line by line. Every message names the amount, the record and
who owns the next action; nobody is told about their own action. Email and the in-app
inbox are separate rows on the same event, so push can be added later without a
schema change (PRD 21.4).

### Scheduled jobs

`vercel.json` registers six crons against `/api/v1/cron/*`, all guarded by a
constant-time `CRON_SECRET` comparison that fails closed. Each is idempotent —
running one twice sends one reminder — and bounded.

| Job | Schedule | Does |
|---|---|---|
| `ticket-sla` | every 5 min | Triage reminders, second-interval escalation, due-date notices, DONE reminder at 24 h, auto-close at 48 h |
| `outbox` | every 5 min | Retries email that did not go out on the write |
| `vendor-overdue` | hourly | F12 for expected delivery dates that have passed, and clears it when goods arrive |
| `daily-digest` | daily | PRD 10's digest to Finance, Management and opted-in HODs — only what is still outstanding, and nothing at all when there is nothing |
| `income-followups` | daily | Pledges unreceived past `income_followup_days` |
| `gc-attachments` | daily | Uploads that never found a parent, plus spent rate-limit windows |

### Security

- **CSP and headers** on every response from `proxy.ts`, including
  `frame-ancestors 'none'` and HSTS in production.
- **Attachments** are only ever URL'd to someone who can see the parent record; an
  unbound upload belongs to its uploader alone. Both are tested.
- **Rate limiting** on presigned uploads, exports, invitations and sign-in links, in
  Postgres rather than memory because the app runs as several instances. The permission
  check runs first, so a refused caller cannot spend anyone's quota.
- **Audit log** is append-only at the database, by trigger *and* by revoked grants on
  the application role. The seed and tests use one documented, session-scoped
  exception (`lib/test-support.ts`); nothing under `app/` or `lib/services/` may.

Run against a fresh database, `pnpm db:migrate && pnpm db:seed` produces 32 tables,
the four `v_*` views, `citext`/`pgcrypto`/`pg_trgm`, and both audit triggers.

## What is not built

Everything here is PRD section 15's **v1.1**, i.e. explicitly after launch:

- Receipt OCR auto-fill (8.1) and the model-based flags F7, F10, F11. The rule
  functions exist and are unit-tested; they need `ocr_json` to be populated.
- Web Push / WhatsApp for Urgent tickets. PRD 14 requires this **before fest week** —
  it is the one v1.1 item with a hard deadline. Notification rows are already written
  per channel, so this is a sender, not a schema change.
- Ticket templates (the table exists), calendar view, SSE live updates, light theme.
- Playwright end-to-end tests. The three core flows are covered at the route-handler
  level in `tests/api/flows.test.ts`, which exercises the real handlers, services and
  SQL — but not the browser.

## Assumptions carried from the PRD

Section 17's open questions are unresolved; the drafts stated there are what is
built, and each is noted where it is implemented. Notably: line items need no
approval gate (Q20), over-budget requests are flagged not blocked (Q2), Members see
their own department read-only (Q7), Finance HOD is the platform admin (Q14), and a
Finance HOD's own reimbursement is approved by Management (Q9).
