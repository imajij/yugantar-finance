# Load and end-to-end report — 400 concurrent users

Run on 2026-08-30 against `infra/loadtest.mts` (`pnpm loadtest`), commit at the time
of writing. Every call went through the real HTTP API with a real session cookie
obtained from the real sign-in callback — the path a person takes when they click
the link in their invitation. Nothing called a service directly.

## Verdict

**No P0s. Nothing broke.** 6,321 requests from 400 signed-in users, zero failures,
and every money invariant held afterwards. The platform handles the load a fest of
this size will put on it, with the caveat in *What this does and does not prove*
below.

| | |
|---|---|
| Users signed in end to end | 400 / 400 |
| Departments | 14 |
| Requests | 6,321 in 22.1s |
| Failures | **0** |
| Claims filed → endorsed → approved → paid | 226 → 203 → 201 → 198 |
| Tickets raised | 260 |
| Chat messages | 1,152 |
| Audit events written | 1,111 |

## What was exercised

Sign-in for all 400 (invitation token → `/auth/callback` → session cookie), then a
mixed workload weighted by role and run at real concurrency:

- **Members** — dashboard, receipt upload (presign → PUT → complete), reimbursement
  filing, tickets to their own head, department chat, notifications.
- **Heads** — endorsement queue, ticket inbox, department budget summary, endorsing
  claims, cross-department tickets.
- **Finance** — fest dashboard, approvals, line items, reserve transfers.
- **Management** — payment queue, recording payments.

Then the money path was drained end to end — every head endorsed their queue,
Finance approved what was endorsed, Management paid what was approved — because a
claim that never reaches PAID has not tested the part that matters.

## Capacity

The same workload at rising concurrency. This is the only way a latency number
means anything: 900ms at 400 is a different fact from 900ms at 50.

| Concurrent | Throughput | p50 | p95 | Errors |
|---|---|---|---|---|
| 50 | 345/s | 127ms | 244ms | 0 |
| 150 | 419/s | 285ms | 468ms | 0 |
| 400 | 496/s | 545ms | 915ms | 0 |

Throughput plateaus around 400–500/s while latency rises roughly linearly with
concurrency. That is a saturated system: it is serialising on something.

**It is not the database.** Sampled during a run at 400 concurrent, the Node process
sat at **~110% CPU** while the Postgres backend sat at **0%**. The ceiling is
application CPU on one process.

**It is not the connection pool either.** `db/index.ts` opens `max: 5`. Raising it to
25 and re-running moved p95 at 400 from 906ms to 781ms — about 14%, and throughput
by 8%. Real but marginal, and not the wall. The pool was left at 5: it is a
deliberate serverless choice, and on Vercel each instance keeps its own, so a large
value multiplies across instances against Neon's connection limit.

## Correctness under concurrency

The interesting part, and the reason this was run at all. Each of these was fired
deliberately rather than hoped for.

| Probe | Result |
|---|---|
| 20 simultaneous transitions on one claim | One won; the rest got `CONFLICT`. No double transition. |
| 14 simultaneous reserve transfers | All serialised on the fest row. Σ allocations stayed within the fest total. |
| One `Idempotency-Key`, 10 simultaneous requests | **1 ticket created.** |
| Claims paid twice | **0** |
| Payments recorded with no UTR | **0** |
| Σ allocations vs fest total | 28,010,000,000 / 50,000,000,000 — within |

The five P0s fixed earlier this week all hold under real concurrency rather than
just in a test that stages one.

## Slowest paths

Nothing failed, but these are where the time goes at 400 concurrent:

| Operation | p50 | p95 |
|---|---|---|
| `GET /budget` (department summary) | 524ms | 1,069ms |
| `POST /reimbursements` | 439ms | 979ms |
| `POST /tickets` | 435ms | 951ms |
| `GET /dashboard` | 437ms | 908ms |
| `GET /channels` | 324ms | 751ms |

`GET /budget` is the slowest thing in the product. It reads the five numbers from
the SQL views, which is correct by design (18.2 rule 3) — but it is the page most
likely to feel slow on a busy day, and the first place to look if it ever does.

## What this does and does not prove

**Does:** that the workflows are correct when 400 people run them at once; that the
races have no winner but the first; that the books balance afterwards; that 400
accounts can be created and signed in end to end without a hitch.

**Does not:** that production throughput is ~500/s. This ran as **one Node process
on one laptop**, and that process was the bottleneck. Production is Vercel
serverless against Neon, which fans out across instances — so the ceiling measured
here is an artifact of the harness, not a property of the deployment. What does
transfer is the per-request latency at low concurrency (p50 ~127ms at 50), the
database behaviour, and every correctness result above.

To measure real capacity, run this against the deployment: `SMOKE_URL=https://…
pnpm loadtest`. It needs database access to seed and to flush, so it wants a staging
deployment rather than production.

## One thing worth knowing

`dropFests` clears everything scoped to a fest. `rate_limits` is not — it is keyed by
bucket and window, not by fest — so 3,752 rows survived the flush. They are not a
leak: `pruneRateLimits()` runs nightly from `jobs/gc-attachments.ts`, and any window
older than two days can never be hit again. Cleared manually here so the database
finished at exactly zero rows.

## Data created and removed

Everything hung off one fest with a `load-` slug prefix, which is what made the
cleanup exact rather than hopeful. After `--flush`:

```
tables: 38   rows remaining: 0   every table empty
```

The load test ran against a **disposable Postgres**, not the project database: the
local instance was down and there was no container runtime, so a standalone
PostgreSQL 18 was started on port 5455, migrated, used, and deleted along with its
data directory. Nothing was written to Neon, and `.env.local` was restored.
