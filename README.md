# Yugaantar Finance & Operations Dashboard

Role-based dashboard for Yugaantar '26: budget and line items, reimbursements,
vendor payments, income, work tickets, flags and audit. Spec: [`system_PRD.md`](./system_PRD.md).

## Status

**M1–M3 built.** Verified against a live database and the running app.

| Milestone | State |
|---|---|
| M1 Foundation | Schema, `can()`, audit service, attachments upload, app shell, dev sign-in. **Clerk not wired** (dev sign-in stands in), no notifications inbox yet. |
| M2 Budget | Fest total, allocations, transfers, line items with supporting documents, the `v_*` views, department and fest dashboards, flags F13/F14. Budget-review screen pending. |
| M3 Reimbursements | Full 7.2 state machine, member form, request detail, the three queues, flags F1–F6, comments and email pending. |
| M4 Vendors & income | Not started. |
| M5 Work tickets | Not started. |
| M6 Close-out | Not started. |

| Piece | Where | Proven by |
|---|---|---|
| Database schema (19.2/19.3) | `db/schema.ts`, `db/migrations/0000_init.sql` | migrates clean on Postgres 18 |
| Budget arithmetic views (19.4) | `db/migrations/0001_views.sql` | `tests/db/budget-arithmetic.test.ts` — the 19.6 fixture |
| The three hard blocks (4.7, 7.5) | `lib/services/{line-items,budget}.ts` | `tests/db/budget-guards.test.ts` |
| Reimbursement flow + segregation | `lib/services/reimbursements.ts` | `tests/db/reimbursement-flow.test.ts` |
| Money in paise (18.2 rule 4) | `lib/money.ts` | `tests/unit/money.test.ts` |
| State machines (7.2/7.3/7.5/7.7) | `lib/state-machines/` | `tests/unit/state-machines.test.ts` — every `from × action` |
| Authorization + segregation (5.1/5.2) | `lib/authz.ts` | `tests/unit/authz.test.ts` — the 5.1 matrix |
| Flag rules (8.2) | `lib/flags/` | covered in the reimbursement flow tests |
| Brand theme (9.1) | `app/globals.css`, `lib/state-chip.ts` | `tests/unit/state-chip.test.ts` |

Not yet built: Clerk sign-in and its webhook, R2, email, comments, the ticket and
vendor state machines' services and screens, income, cron jobs, exports.

## Setup

Requires Node 22+, pnpm, and Docker (for the local database).

```bash
pnpm install
cp .env.example .env.local           # fill in; DATABASE_URL below works out of the box
docker run -d --name yugantar-pg -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=yugantar \
  -p 5433:5432 postgres:18-alpine
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`DATABASE_URL=postgres://postgres:dev@localhost:5433/yugantar`

## Scripts

| Command | Does |
|---|---|
| `pnpm dev` | Next.js dev server |
| `pnpm test` | Vitest — unit tests plus the budget-arithmetic fixture against `DATABASE_URL` |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm db:generate` | Regenerate a migration after editing `db/schema.ts` |
| `pnpm db:migrate` | Apply migrations |
| `pnpm db:seed` | Reset and reseed the demo fest (idempotent) |
| `pnpm db:studio` | Drizzle Studio |

## Demo path

After `pnpm db:seed` the database holds Yugaantar '26 with a ₹25,00,000 total budget,
₹19,00,000 allocated across five departments and ₹6,00,000 in Reserve, seven users
(one per role), nine expense types, and seven line items — three of them carrying
quotations, and *Stage lighting* deliberately left above the ₹10,000 document
threshold with no document so flag **F13** has something to find.

Seeded sign-ins (once Clerk is wired): `finance.hod@`, `management@`, `tech.hod@`,
`logistics.hod@`, `sponsorship.hod@`, `tech.member@`, `logistics.member@` — all
`@sst.scaler.com`.

## Assumptions carried from the PRD

Section 17 open questions are unresolved; the drafts stated there are what is built.
Notably: line items need no approval gate (Q20), over-budget requests are flagged not
blocked (Q2), Members see their own department read-only (Q7), Finance HOD is the
platform admin (Q14), and a Finance HOD's own reimbursement is approved by Management (Q9).

Two deviations from PRD section 18, both deliberate:

- **Database driver.** `postgres-js` rather than the Neon HTTP driver, because rule 5
  ("every write is one transaction") needs interactive transactions, which the HTTP
  driver does not support. Works unchanged against a Neon pooled connection string.
- **Local Postgres.** Development and the arithmetic fixture run against a throwaway
  Docker container, so no Neon branch is needed to run the tests.
