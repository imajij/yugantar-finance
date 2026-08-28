<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Yugaantar Finance & Operations

`system_PRD.md` is the spec and is binding. Sections 18–21 are the engineering
handoff; where behaviour and architecture conflict, fix the later section.

## Non-negotiables (PRD 18.2)

1. Every route handler calls `can()` from `lib/authz.ts` before doing anything.
   The UI may use it to hide controls; hiding is never the enforcement.
2. State machines are data in `lib/state-machines/*`. Handlers never branch on status.
3. The five numbers come from the SQL views in `db/migrations/0001_views.sql`. Never
   stored, never computed in JS.
4. Money is integer paise everywhere. `lib/money.ts` is the only place amounts are formatted.
5. Every write is a service call in `lib/services/*`, one transaction, audit event inside it.
6. Segregation of duties lives in `can`, not the UI.
7. Soft delete only. `audit_events` is append-only.
8. Human IDs come from `lib/human-id.ts`, allocated in the creating transaction.
9. Transition and payment endpoints honour `Idempotency-Key`.
10. Every query is scoped by the caller's `fest_id`. No endpoint takes a fest ID from the client.

## Local development

```
docker start yugantar-pg      # throwaway Postgres on :5433
pnpm db:migrate && pnpm db:seed
pnpm dev
pnpm test && pnpm lint && pnpm typecheck
```

`tests/db/budget-arithmetic.test.ts` is the PRD 19.6 fixture. If it fails, the
budget views no longer implement section 6.2 / 6.3 — fix the views, not the test.

`pnpm smoke --keep` then `pnpm responsive` is the wider pass: the first walks the
API over HTTP and leaves a fest with real rows behind, the second renders every
screen at five widths against it. A sweep run against an empty database renders
empty states and passes without testing anything, which is why the order matters.

## CI

`.github/workflows/ci.yml` runs all of the above on every push: lint, types and
the suite in one job, then build → start → smoke → sweep in another, both against
a throwaway Postgres. It is **not a merge gate until branch protection is turned
on** (Settings → Branches → require `check` and `walk`), and until then a red
commit still deploys — migrations first.
