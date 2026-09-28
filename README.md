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
| M1 Foundation | Schema, `can()`, audit service, attachments, app shell, sign-in by emailed links | ✅ |
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
| `pnpm test`, `pnpm lint`, `pnpm typecheck` pass; `pnpm db:seed` produces a working deployment | 413 tests across 16 files, plus `pnpm smoke` over HTTP |

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
| `pnpm vercel-build` | What the deploy runs: migrate, then build |
| `pnpm db:seed` | Bootstrap the fest and its first administrator (idempotent; `--reset` starts over) |
| `pnpm db:studio` | Drizzle Studio |
| `pnpm env:check` | Which API keys are set, what they unlock, what is missing |
| `pnpm smoke` | Drive every endpoint against a running server over HTTP, then tidy up. `--keep` leaves the fest behind — it is the only realistic dataset there is |
| `pnpm walkthrough:pdf` | Render `docs/walkthrough.html` to an A4 handout. The page is dark; the print stylesheet flips it to the light variant, per 9.1 rule 6 |
| `pnpm responsive` | Load every screen at five widths in a headless browser and fail on anything that scrolls sideways. Takes a path to check one |
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
  (auth)/                       sign-in (emailed link) and the link callback
  (app)/                        dashboard requests tickets budget vendors income
                                queues flags notifications close-out audit admin
  api/v1/…                      route handlers: parse → can() → service → respond
proxy.ts                        security headers (CSP)
lib/
  authz.ts  entities.ts         permissions; (type, id) → the resource `can` needs
  api.ts                        route wrapper: session, params, idempotency, errors
  state-machines/  services/    transition tables; all writes, one transaction each
  services/planning.ts          labels, projects and cycles — the board's vocabulary
  services/allocations.ts       an HOD's ask for a different department allocation
  services/chat.ts              channels and messages; membership is the audience
  rows.ts                       reading a raw db.execute result without lying about it
  flags/  queries/              F1–F14; the five numbers, queues and dashboards
  money.ts  human-id.ts         paise and ₹; per-fest sequences
  storage.ts  email.tsx         R2 (SigV4, no SDK) or local disk; Resend
  auth.ts  session.ts           sign-in links and sessions; who the caller is
  env.ts                        reading config, where blank means unset
  email-domains.ts  rate-limit.ts  who may be invited; fixed-window limits
  xlsx.ts  test-support.ts      a minimal XLSX writer; the audit-guard escape hatch
emails/                         the notification template (dark, table-based HTML)
jobs/                           cron logic, called by app/api/v1/cron/*
db/                             schema, migrations (incl. the 19.4 views), seed
tests/  unit/ db/ api/          state machines, money, flags · services + SQL · handlers
```

Five deliberate deviations from the PRD, each noted at the point of use:

- **Database driver.** `postgres-js` rather than the Neon HTTP driver, because rule 5
  ("every write is one transaction") needs interactive transactions, which the HTTP
  driver does not support. Works unchanged against a Neon pooled connection string.
- **Emails follow the dashboard, not the PRD.** 21.4 says emails are light. They are
  dark, in the 9.1 palette, because a sign-in link that looks nothing like the thing
  it signs you into is its own small trust problem. Built for email clients rather
  than browsers — `bgcolor` attributes alongside CSS, everything inline, an explicit
  `color-scheme` so Apple Mail does not invert it. Exports stay light, as specified.
- **Sign-in without Clerk.** PRD 13 names Google Workspace via Clerk. The fest
  decided against Clerk, so sign-in is an emailed one-time link — same passwordless
  shape, same domain restriction, same invitation-only rule. The `users.clerk_user_id`
  column is left in place, unused. See [Signing in](#signing-in).
- **A planning layer on work tickets.** PRD 7.7 describes tickets as cross-department
  asks and nothing more — "no subtasks, no dependencies, no sprints". A fest week
  generates hundreds of them, and five fixed tabs cannot organise that, so the board
  borrows Linear's shape: labels, projects, cycles, sub-tickets, and a board/list
  toggle with grouping and filters that live in the URL. None of it can decide
  anything — no label grants a permission, no project changes who may accept work.
  The one change to the machine itself is a `BACKLOG` state, because "yes, ours, and
  not this week" was a triage answer the machine could not express. See
  [Work tickets](#work-tickets).
- **XLSX and PDF.** `lib/xlsx.ts` writes the ZIP and SpreadsheetML directly rather
  than pulling a spreadsheet library into a serverless bundle; it is unit-tested by
  reading the bytes back (`tests/unit/xlsx.test.ts`). PRD 12's PDF outputs are served
  as a light-themed, A4-styled HTML page that the browser prints — the same artefact
  without a rendering engine in the bundle.

### Work tickets

The board is a view, not a state: the scope, grouping, filters and layout all live
in the URL, so any board is a link you can send — "every urgent Logistics ticket in
this cycle" — and the back button behaves. `C` opens a new ticket, `/` searches,
`J`/`K` move, and `S`/`A`/`P`/`L` change status, assignee, priority and labels on
the selected row. `?` lists the rest.

Two things about it are deliberately unlike Linear.

**Dragging a card does not set its status.** A status only ever moves through the
state machine (rule 2), where each transition knows who may fire it and what it
needs — rejecting takes a reason, starting work is the assignee's to do. So a drop
resolves to the first *legal* transition into that column and is refused, out loud,
when there is none. The board can express everything the rules allow and nothing
they don't.

**Scopes name what they filter on.** The old tab bar had "Sent" beside "Raised by
me", which are not siblings: one is every ticket your *department* raised, the other
the ones *you* typed — a subset. They are now `outgoing` and `created`, on either
side of `inbox`, `assigned` and `subscribed`. The old names still resolve, so
existing links keep working.

Labels, projects and cycles are managed at `/tickets/planning` rather than inside
the pickers. Creating a label mid-triage is fast and is also how you end up with
"sound", "Sound" and "sound-system" by the second day of a fest.

### Asking for a budget

A department head owns their budget's *shape* — the line items, now editable from
the department page — but not its *size*. That distinction is PRD 5.2 and it stays:
a department that could set its own allocation could empty the reserve, and nothing
downstream would show it as anything but normal.

What was missing was the ask. An HOD now states the total they need and why; Finance
or an administrator answers with a note. Approving performs the transfer in the same
transaction and stores its id, so the ask and the money are one trail. The
arithmetic is checked at the moment of approval, not of asking — a request raised on
Monday can be refused on Friday because the reserve went in between, which is
correct.

### Channels

Each department gets a channel when it is created, with everyone in the department
in it, and its head can make more. There are direct messages too. Both are read
through one rule: **a channel's audience is its membership rows.** Another
department's head cannot open this one's channel because they are not in it — not
because a role check said no, which is the kind of thing that gets forgotten at one
call site out of twelve. Membership follows the department, so moving somebody out
of Tech takes their Tech channels with them.

A Finance HOD sees every rupee in the fest and no conversation they are not part of.
That is on purpose and it is tested.

The single exception is the administrator, who reads every channel. Two things make
that oversight rather than surveillance, and both are load-bearing:

- **it is disclosed** — the channel header says so to everyone in the channel, not
  just to the administrator;
- **it is recorded** — opening a channel you are not in writes
  `channel.oversight_read` to the append-only audit log, filterable at
  `/api/v1/audit?entity_type=CHANNEL`.

Reading is all it is. Posting needs membership, so an administrator who wants to say
something joins first and appears in the member list like anybody else.

Messages carry text, `@mentions` of people in the channel, threaded replies, files
through the same R2 path as receipts, and links to reimbursements, tickets, vendor
requests and vendors — each rendered with its ID and status, and only for readers
who could open the record anyway. A link is never a way to read something you
could not otherwise see.

New messages arrive by polling, not a socket. Vercel's functions are not long-lived
and there is no shared broker here, so a WebSocket would be a long-poll wearing a
costume; this is the honest version of the same latency. It polls only while the tab
is visible and asks only for messages newer than the last one it has.

An invitation can be sent again from Admin without deleting the account — which
matters, because every audit row already points at that id. It is the same message
the original invitation sent, and an active account can be sent a fresh sign-in link
the same way.

### When a workflow stalls

Segregation of duties (5.2) means an approved reimbursement can only be paid by
Management. A fest whose Management account never accepted its invitation therefore
accrues Committed forever, with Spent stuck at zero — correct arithmetic, stopped
workflow, and nothing anywhere saying why. The person who notices is Finance,
looking at a figure that will not move; the queue that would explain it belongs to
somebody who does not exist.

The budget and queue screens now say so plainly, with the amount and a link to fill
the seat. The fix is to fill it, not to move the authority.

### Raising a concern

Flags F1–F14 examine records with numbers in them. What a rule cannot see is what a
person notices about a *department* or another *person*: a team sitting on unreviewed
line items, an HOD whose claims all arrive on the last day. Anyone running a
department can now raise one by hand, from the record itself, and it lands in the
same queue and resolves the same way. Whoever raised one may withdraw it; clearing
somebody else's stays Finance's call.

Unlike a rule's flag these are not deduplicated — two people noticing two different
things about one record is the point — so the partial unique index that stops a
re-running rule piling up duplicates is scoped to rule-raised flags.

### Showing it to somebody

`docs/walkthrough.html` is a presentable walkthrough — the approval spine, the five
numbers, the state machines, every feature, an eight-minute demo script with
timings, and the questions people actually ask in the room. It uses the fest's own
tokens and typefaces, so the deck and the product read as one thing.

`pnpm walkthrough:pdf` renders it to an A4 handout. Print asks for the light variant
rather than screenshotting the dark screen version, which is the same rule the app
follows for emails and exports — the diagrams restyle themselves because every
colour in them is a token rather than a literal.

### Checking it stays responsive

`pnpm responsive` loads every screen at 360, 390, 768, 1024 and 1440 in headless
Chromium and measures whether the page itself scrolls sideways — which is the
dominant cause of "the UI breaks on my phone" and is a fact rather than a matter of
taste. It reports the widest offending element, so a failure names the thing to fix.

Two details it took a wrong answer to get right. It compares against
`documentElement.clientWidth`, not the window: a vertical scrollbar narrows the
content box while `scrollWidth` stays put, which reads as a phantom few pixels of
overflow on any page long enough to scroll. And it ignores anything inside a
horizontal scroller — a Kanban board is *meant* to scroll — while still reporting a
scroller whose content is far wider than a phone, because a table you have to swipe
to read is legal and still useless. Buried controls are measured at the bottom of
the page; mid-scroll, whatever sits under the fixed tab bar can be scrolled out of
it.

Run it against data. `pnpm db:seed` produces an empty fest, so every table renders
its empty state and the sweep passes without testing anything —
`pnpm smoke --keep` leaves behind a fest with departments, line items, claims at
every stage, vendors, tickets and channels, and the sweep points itself at whichever
fest has the most in it.

### The interface

`system-design.md` is the design brief and the record of what was built from it.
The short version: colour tokens are unchanged — which state is which colour appears
in exports and in an audit and is not a styling decision — and what changed is
structure.

One typographic and density scale (rows 44px, cards 28px inside, sections 24px
apart, radii 20 / 16 / 14 / 999), a 44px floor under anything you tap, and three
levels of emphasis with a rule for each.

The piece that matters most is the five numbers. They were five sibling boxes, which
is a lie about what they are: Available is not a peer of Allocated, Pending,
Committed and Spent — it is what is *left* after them. HODs read five equal cards,
saw a number lower than they expected, and had no way to discover that a request
awaiting a decision had already been held back. Now the figure is Available and the
other four are drawn as what it was derived from — a segmented bar in spend order,
and the arithmetic written out as deductions beneath it (`components/five-numbers.tsx`).

Two other things worth knowing. `/requests/new` is three steps with the camera
first, because the hard case is a Member outside a venue at 11pm holding a phone in
one hand. And every `window.prompt` is gone: anything needing a written reason for
the permanent record opens `components/confirm.tsx`, which states the consequence
before it asks, says the reason goes to the audit log against your name, and will
not enable the action until there is one.

## Integrations

Each degrades to something usable rather than failing, so the app runs with none of
them configured. All are wired and ready for credentials.

| Service | Configured | Not configured |
|---|---|---|
| **Cloudflare R2** (`R2_*`) | Private bucket; presigned PUT for upload, presigned GET for reads, both 15 minutes. SigV4 signed in `lib/storage.ts` — no AWS SDK. See [Setting up R2](#setting-up-r2) | Files go to `./.uploads` with HMAC-signed URLs of the same shape and expiry. `UPLOAD_URL_SECRET` is required for this path in production |
| **Resend** (`RESEND_API_KEY`, `EMAIL_FROM`) | Notifications are written in the same transaction as the write that caused them, then sent after the response commits (`after()`); failures retry on the `/cron/outbox` sweep | Rows stay unsent and the body is logged. The in-app inbox works either way |
| **Anthropic** (`ANTHROPIC_API_KEY`) | — | Receipt OCR and the model-based flags are v1.1 (PRD 15). `attachments.ocr_json` exists, so adding them needs no migration |

### Signing in

Sign-in is a one-time link emailed to an invited address (`lib/auth.ts`);
`lib/session.ts` resolves it to a row in `users` with a role and a department, and
authorization runs on that. What makes it safe:

- **An invitation is the gate.** A link is only ever issued to an address that already
  has a `users` row. Nobody signs themselves up.
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
curl -sI https://yugantar.ajij.dev/sign-in | grep -i content-security-policy
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

Six jobs, all guarded by a constant-time `CRON_SECRET` comparison that fails closed,
all idempotent — running one twice sends one reminder — and all bounded.

| Job | Does | Cares about |
|---|---|---|
| `ticket-sla` | Triage reminders, second-interval escalation, due-date notices, DONE reminder at 24 h, auto-close at 48 h | **minutes** |
| `outbox` | Retries email that did not go out on the write | minutes |
| `vendor-overdue` | F12 for delivery dates that have passed, and clears it when goods arrive | days |
| `daily-digest` | PRD 10's digest — only what is still outstanding, and nothing at all when there is nothing | days |
| `income-followups` | Pledges unreceived past `income_followup_days` | days |
| `gc-attachments` | Uploads that never found a parent, spent rate-limit windows, dead sessions | days |

Each has its own endpoint, and `/api/v1/cron/all` runs the lot in one request,
reporting each separately and failing only if something actually failed.

**On Vercel Hobby, cron runs at most once a day.** `vercel.json` is set up for that:
one daily call to `/api/v1/cron/all`. That is fine for the four jobs that think in
days — and wrong for the ticket SLA clock, because PRD 14 wants an urgent ticket
reaching the target department within a minute on fest days, and a triage reminder
that arrives tomorrow is not a reminder.

So `.github/workflows/cron.yml` drives `ticket-sla` and `outbox` every five minutes
from GitHub Actions. It needs a `CRON_SECRET` secret and an `APP_URL` variable on the
repository, and no-ops without them. Treat it as a stopgap: GitHub's scheduler is
best-effort, skews under load and drops runs entirely when busy. **Before fest week**,
move to something with a real guarantee — Vercel Pro, a Cloudflare Worker cron, or any
hosted scheduler — pointed at the same endpoints. Nothing in the app changes.

### Security

Three sweeps back the permission model, and two of them discover what to test rather
than being told, so a new endpoint is covered without anyone remembering to add it:

| | |
|---|---|
| `tests/api/no-unauthenticated-access.test.ts` | Walks `app/api/v1`, calls every method of every route with no session, and requires a refusal. The five public endpoints are allowlisted **with a stated reason each**, and the list is checked against reality |
| `tests/api/fest-isolation.test.ts` | Builds two complete fests and, as an *administrator* of one, reaches for the other's records by their real ids — 18.2 rule 10, tested with the strongest role, because a Member being refused proves little |
| `tests/api/permissions.test.ts` | The 5.1 matrix: every role against every endpoint it must not use |

- **CSP and headers** on every response from `proxy.ts`, including
  `frame-ancestors 'none'` and HSTS in production.
- **Id-shaped route params must be UUIDs**, checked in the route wrapper. Postgres
  answers a malformed id with `invalid input syntax for type uuid`, which arrives as a
  500 — wrong twice, since it is the caller's mistake and "no such record" is truer.
- **Request bodies are capped at 128 KB**, measured on the text rather than trusted
  from `Content-Length`. Files never come through the API; they go straight to storage
  on a presigned URL.
- **Writes are rate limited per user** on top of the per-endpoint limits, high enough
  that no honest use meets it and low enough that a loop or a stolen session cannot
  grind through the database.
- **Attachments** are only ever URL'd to someone who can see the parent record; an
  unbound upload belongs to its uploader alone. Both are tested.
- **Rate limiting** on presigned uploads, exports, invitations and sign-in links, in
  Postgres rather than memory because the app runs as several instances. The permission
  check runs first, so a refused caller cannot spend anyone's quota.
- **Audit log** is append-only at the database, by trigger *and* by revoked grants on
  the application role. The seed and tests use one documented, session-scoped
  exception (`lib/test-support.ts`); nothing under `app/` or `lib/services/` may.

Run against a fresh database, `pnpm db:migrate && pnpm db:seed` produces 37 tables,
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
