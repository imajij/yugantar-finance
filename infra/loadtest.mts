/**
 * A fest's worth of people, using the platform at once.
 *
 * Everything here goes through the real HTTP API with a real session cookie
 * obtained from the real sign-in callback — the same path a person takes when they
 * click the link in their invitation email. Nothing calls a service directly, so
 * what this measures is the product, not a subset of it.
 *
 * **Containment.** Every row this creates hangs off one fest whose slug starts with
 * `load-`. That is what makes `--flush` exact rather than hopeful: `dropFests`
 * takes the prefix and nothing outside it can be reached.
 *
 *   pnpm loadtest              # build, run, report, leave the data
 *   pnpm loadtest --flush      # …and delete it afterwards
 *   pnpm loadtest --users 350
 */
import { randomBytes, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { dropFests } from "@/lib/test-support";

const BASE = (process.env.SMOKE_URL ?? "http://localhost:3100").replace(/\/$/, "");
const PREFIX = "load-";
const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
};
const USERS = arg("users", 350);
const DEPARTMENTS = arg("departments", 12);
const ROUNDS = arg("rounds", 3);
const FLUSH = process.argv.includes("--flush");

/* --------------------------------------------------------------- measuring */

interface Sample { op: string; ms: number; status: number; ok: boolean; note?: string }
const samples: Sample[] = [];
const started = Date.now();

interface Actor { id: string; email: string; role: string; deptId: string; cookie: string }

/** One HTTP call, timed and recorded. Never throws — a failure is data. */
async function call(
  op: string, method: string, path: string,
  opts: { as?: Actor; body?: unknown; expect?: number[] } = {},
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const t0 = performance.now();
  let status = 0;
  let json: Record<string, unknown> | null = null;
  let note: string | undefined;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        // A distinct caller per user, so per-IP limits do not stand in for per-user ones.
        "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.as ? { cookie: opts.as.cookie } : {}),
        ...(method !== "GET" ? { "Idempotency-Key": randomBytes(12).toString("hex") } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: "manual",
    });
    status = res.status;
    const text = await res.text();
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
    if (status >= 400) {
      const err = json?.error as { code?: string; message?: string } | undefined;
      note = `${err?.code ?? status}: ${(err?.message ?? "").slice(0, 60)}`;
    }
  } catch (e) {
    note = `network: ${(e as Error).message.slice(0, 40)}`;
  }
  const expected = opts.expect ?? [200, 201, 204, 307];
  samples.push({ op, ms: performance.now() - t0, status, ok: expected.includes(status), note });
  return { status, json };
}

/** Runs `jobs` with at most `width` in flight — real concurrency, bounded like a browser pool. */
async function swarm<T,>(jobs: (() => Promise<T>)[], width: number): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) {
      const mine = next++;
      await jobs[mine]();
    }
  }));
}

const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> =>
  ((await db.execute(q)) as unknown as T[])[0];

const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

const pctOf = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length * p)] ?? 0;

/* ------------------------------------------------------------------- setup */

console.log(`\n  ${USERS} users · ${DEPARTMENTS} departments · ${ROUNDS} rounds · ${BASE}\n`);

const festId = (await one<{ id: string }>(sql`
  insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end,
                     total_budget_paise, settings)
  values ('Load Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14',
          50000000000, '{"line_item_doc_threshold_paise": 100000000}'::jsonb)
  returning id`)).id;

const mkDept = async (name: string, slug: string, kind: string, alloc = 0) =>
  (await one<{ id: string }>(sql`
    insert into departments (fest_id, name, slug, kind, allocated_paise)
    values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${alloc})
    returning id`)).id;

const financeDept = await mkDept("Finance", "finance", "FINANCE");
const coreDept = await mkDept("Core", "core", "CORE");
const budgetDepts: string[] = [];
for (let i = 0; i < DEPARTMENTS; i++) {
  budgetDepts.push(await mkDept(`Dept ${i + 1}`, `dept-${i + 1}`, "BUDGET", 2000000000));
}

const mkUser = async (name: string, email: string, role: string, deptId: string, superAdmin = false) =>
  (await one<{ id: string }>(sql`
    insert into users (fest_id, name, email, role, department_id, status, upi_id, is_super_admin)
    values (${festId}, ${name}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE',
            ${email.split("@")[0] + "@upi"}, ${superAdmin})
    returning id`)).id;

/**
 * The real sign-in, for every one of them.
 *
 * A token is planted and the callback followed, which is exactly what clicking the
 * link in an invitation email does — the raw token never leaves the server
 * otherwise, only its hash is stored, so the harness writes its own.
 */
async function signIn(id: string, email: string, role: string, deptId: string): Promise<Actor | null> {
  const raw = `load-${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`
    insert into sign_in_tokens (user_id, token_hash, expires_at)
    values (${id}, ${createHash("sha256").update(raw).digest("hex")}, now() + interval '60 minutes')`);

  const t0 = performance.now();
  const res = await fetch(`${BASE}/auth/callback?token=${encodeURIComponent(raw)}`, { redirect: "manual" });
  const cookie = /yg_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  samples.push({ op: "auth/callback", ms: performance.now() - t0, status: res.status, ok: Boolean(cookie) });
  return cookie ? { id, email, role, deptId, cookie: `yg_session=${cookie[1]}` } : null;
}

const roster: { id: string; email: string; role: string; deptId: string }[] = [];
const stamp = randomBytes(3).toString("hex");
roster.push({
  id: await mkUser("Finance HOD", `finance.${stamp}@sst.scaler.com`, "FINANCE_HOD", financeDept, true),
  email: `finance.${stamp}@sst.scaler.com`, role: "FINANCE_HOD", deptId: financeDept,
});
roster.push({
  id: await mkUser("Management", `mgmt.${stamp}@sst.scaler.com`, "MANAGEMENT", coreDept),
  email: `mgmt.${stamp}@sst.scaler.com`, role: "MANAGEMENT", deptId: coreDept,
});
for (const [i, d] of budgetDepts.entries()) {
  const email = `hod${i + 1}.${stamp}@sst.scaler.com`;
  roster.push({ id: await mkUser(`HOD ${i + 1}`, email, "DEPT_HOD", d), email, role: "DEPT_HOD", deptId: d });
}
for (let i = roster.length; i < USERS; i++) {
  const d = budgetDepts[i % budgetDepts.length];
  const email = `member${i}.${stamp}@sst.scaler.com`;
  roster.push({ id: await mkUser(`Member ${i}`, email, "MEMBER", d), email, role: "MEMBER", deptId: d });
}
console.log(`  seeded ${roster.length} accounts, ${budgetDepts.length + 2} departments`);

const actors: Actor[] = [];
await swarm(roster.map((r) => async () => {
  const a = await signIn(r.id, r.email, r.role, r.deptId);
  if (a) actors.push(a);
}), 40);
console.log(`  signed in ${actors.length}/${roster.length}\n`);

const finance = actors.find((a) => a.role === "FINANCE_HOD")!;
const management = actors.find((a) => a.role === "MANAGEMENT")!;
const hods = actors.filter((a) => a.role === "DEPT_HOD");
const members = actors.filter((a) => a.role === "MEMBER");

/* ------------------------------------------------- what a fest is made of */

// Finance sets the fest up first, as they would.
const lineItems = new Map<string, string>();
for (const d of budgetDepts) {
  const r = await call("POST /line-items", "POST", `/api/v1/departments/${d}/line-items`, {
    // Under the fest's document threshold, so a claim can attach without a
    // quotation — 7.1 is not what this run is measuring.
    as: finance, body: { name: "Programme", planned_paise: 90000000 },
  });
  if (r.json?.id) lineItems.set(d, String(r.json.id));
}
const expenseTypeId = (await one<{ id: string }>(sql`
  insert into expense_types (fest_id, name) values (${festId}, 'Equipment') returning id`)).id;

// Channels exist because departments do; every member should land in theirs.
await call("GET /channels (backfill)", "GET", "/api/v1/channels", { as: finance });

/* --------------------------------------------------------------- workload */

const claims: { id: string; dept: string }[] = [];
const tickets: string[] = [];

/** One member's minute: read, file a claim, ask their head for something, talk. */
function memberWork(a: Actor): (() => Promise<void>)[] {
  return [
    async () => { await call("GET /dashboard", "GET", "/api/v1/dashboard/me", { as: a }); },
    async () => {
      const li = lineItems.get(a.deptId);
      if (!li) return;
      const up = await call("POST /presign", "POST", "/api/v1/attachments/presign", {
        as: a, body: { purpose: "RECEIPT", file_name: "r.jpg", mime_type: "image/jpeg", size_bytes: 512 },
      });
      const url = String(up.json?.upload_url ?? "");
      if (url) {
        await fetch(url.startsWith("http") ? url : `${BASE}${url}`, {
          method: "PUT", body: new Uint8Array(randomBytes(512)),
        }).catch(() => null);
        await call("POST /complete", "POST", `/api/v1/attachments/${up.json?.attachment_id}/complete`, { as: a });
      }
      // Proof of payment is mandatory on a claim (7.2); one presign stands in for it.
      const proof = await call("POST /presign", "POST", "/api/v1/attachments/presign", {
        as: a, body: { purpose: "CLAIM_PAYMENT_PROOF", file_name: "upi.png", mime_type: "image/png", size_bytes: 512 },
      });
      const proofUrl = String(proof.json?.upload_url ?? "");
      if (proofUrl) {
        await fetch(proofUrl.startsWith("http") ? proofUrl : `${BASE}${proofUrl}`, {
          method: "PUT", body: new Uint8Array(randomBytes(512)),
        }).catch(() => null);
        await call("POST /complete", "POST", `/api/v1/attachments/${proof.json?.attachment_id}/complete`, { as: a });
      }
      const r = await call("POST /reimbursements", "POST", "/api/v1/reimbursements", {
        as: a,
        body: {
          line_item_id: li, expense_type_id: expenseTypeId,
          description: "Cables, tape and batteries for the stage",
          transaction_on: "2026-11-20", amount_paise: 50000 + Math.floor(Math.random() * 200000),
          payee_name: a.email, payee_upi_id: `${a.email.split("@")[0]}@upi`,
          attachment_ids: [String(up.json?.attachment_id ?? "")],
          payment_proof_ids: [String(proof.json?.attachment_id ?? "")], submit: true,
        },
      });
      if (r.json?.id) claims.push({ id: String(r.json.id), dept: a.deptId });
    },
    async () => {
      await call("POST /tickets", "POST", "/api/v1/tickets", {
        as: a,
        body: {
          title: "Two more mic stands for the side stage",
          description: "Ours are all on the main stage until the sound check finishes.",
          target_department_id: a.deptId, due_at: "2026-11-27T16:00:00+05:30",
        },
      });
    },
    async () => { await call("GET /channels", "GET", "/api/v1/channels", { as: a }); },
    async () => { await call("GET /notifications", "GET", "/api/v1/notifications", { as: a }); },
  ];
}

/** A head's minute: triage, endorse, look at the budget, answer people. */
function hodWork(a: Actor): (() => Promise<void>)[] {
  return [
    async () => { await call("GET /queues", "GET", "/api/v1/queues/endorsements", { as: a }); },
    async () => { await call("GET /tickets", "GET", "/api/v1/tickets?view=inbox", { as: a }); },
    async () => { await call("GET /budget", "GET", `/api/v1/departments/${a.deptId}/summary`, { as: a }); },
    async () => {
      const mine = claims.filter((c) => c.dept === a.deptId);
      if (!mine.length) return;
      await call("POST endorse", "POST", `/api/v1/reimbursements/${pick(mine).id}/transitions`, {
        as: a, body: { action: "ENDORSE" }, expect: [200, 409, 403],
      });
    },
    async () => {
      const t = await call("POST /tickets (cross-dept)", "POST", "/api/v1/tickets", {
        as: a,
        body: {
          title: "A van at the loading bay by four",
          description: "Two trips, and somebody to meet the driver.",
          target_department_id: pick(budgetDepts.filter((d) => d !== a.deptId)),
          due_at: "2026-11-27T16:00:00+05:30",
        },
      });
      if (t.json?.id) tickets.push(String(t.json.id));
    },
  ];
}

/** Finance and Management: approve, pay, allocate, read the fest. */
function officeWork(a: Actor): (() => Promise<void>)[] {
  const isFinance = a.role === "FINANCE_HOD";
  return [
    async () => { await call("GET /dashboard/fest", "GET", "/api/v1/dashboard/fest", { as: a }); },
    async () => {
      if (isFinance) return;   // the payment queue is Management's
      await call("GET /queues/payments", "GET", "/api/v1/queues/payments", { as: a });
    },
    async () => {
      if (!isFinance || !claims.length) return;
      await call("POST approve", "POST", `/api/v1/reimbursements/${pick(claims).id}/transitions`, {
        as: a, body: { action: "APPROVE" }, expect: [200, 409, 403],
      });
    },
    async () => {
      if (isFinance) return;
      const q = await call("GET /queues/payments", "GET", "/api/v1/queues/payments", { as: a });
      const first = (q.json?.data as { id: string }[] | undefined)?.[0];
      if (!first) return;
      await call("POST record payment", "POST", `/api/v1/reimbursements/${first.id}/transitions`, {
        as: a, body: { action: "RECORD_PAYMENT", payment_reference: `UTR-${randomBytes(3).toString("hex")}`, paid_at: "2026-11-25" },
        expect: [200, 409, 403],
      });
    },
    async () => {
      // Two departments funded out of the reserve at once — the contention point.
      if (!isFinance) return;
      await call("POST /budget-transfers", "POST", "/api/v1/budget-transfers", {
        as: a,
        body: { to_department_id: pick(budgetDepts), amount_paise: 1000000, reason: "Topping up the programme" },
        expect: [200, 409],
      });
    },
  ];
}

/** Everybody talks. A channel per department, and direct messages across them. */
async function chat(a: Actor) {
  const list = await call("GET /channels", "GET", "/api/v1/channels", { as: a });
  const mine = (list.json?.data as { id: string }[] | undefined) ?? [];
  if (!mine.length) return;
  const channel = pick(mine).id;
  await call("POST /messages", "POST", `/api/v1/channels/${channel}/messages`, {
    as: a, body: { body: `Update from ${a.email.split("@")[0]} — on my way to the venue.` },
  });
  await call("GET /messages", "GET", `/api/v1/channels/${channel}/messages`, { as: a });
}

/* ------------------------------------------------------------------ phases */

const phase = (name: string) => console.log(`\n  ── ${name}`);

function roundJobs(): (() => Promise<void>)[] {
  const jobs: (() => Promise<void>)[] = [];
  for (const a of members) jobs.push(pick(memberWork(a)), () => chat(a));
  for (const a of hods) for (const j of hodWork(a)) jobs.push(j);
  for (const a of [finance, management]) for (const j of officeWork(a)) jobs.push(j);
  return jobs.sort(() => Math.random() - 0.5);
}

/**
 * The capacity curve.
 *
 * The same work at rising concurrency, which is the only way a latency number
 * means anything: 700ms at 350 is a different fact from 700ms at 50, and the shape
 * between them is where the ceiling is.
 */
phase("ramp");
const curve: { at: number; ops: number; seconds: number; p50: number; p95: number; errors: number }[] = [];
for (const width of [50, 150, USERS]) {
  const before = samples.length;
  const jobs = roundJobs();
  const t0 = Date.now();
  await swarm(jobs, width);
  const seconds = (Date.now() - t0) / 1000;
  const slice = samples.slice(before);
  const ms = slice.map((x) => x.ms);
  curve.push({
    at: width, ops: slice.length, seconds,
    p50: pctOf(ms, 0.5), p95: pctOf(ms, 0.95),
    errors: slice.filter((x) => !x.ok).length,
  });
  console.log(`  ${String(width).padStart(4)} at once  ${String(slice.length).padStart(5)} ops  ${seconds.toFixed(1)}s  ${(slice.length / seconds).toFixed(0)}/s  p50 ${pctOf(ms, 0.5).toFixed(0)}ms  p95 ${pctOf(ms, 0.95).toFixed(0)}ms  ${slice.filter((x) => !x.ok).length} errors`);
}

/**
 * The money path, end to end, at volume.
 *
 * The rounds above file claims and barely move them, which is the easy half. This
 * drains the whole pipeline — every head endorses their department's queue, Finance
 * approves what is endorsed, Management pays what is approved — because a claim
 * that never reaches PAID has not tested the part that matters.
 */
phase("money, end to end");
await swarm(hods.map((h) => async () => {
  const q = await call("GET /queues (endorse)", "GET", "/api/v1/queues/endorsements", { as: h });
  for (const r of ((q.json?.data as { id: string }[]) ?? []).slice(0, 12)) {
    await call("POST endorse", "POST", `/api/v1/reimbursements/${r.id}/transitions`, {
      as: h, body: { action: "ENDORSE" }, expect: [200, 409, 403],
    });
  }
}), hods.length);

const endorsed = await call("GET /queues (approve)", "GET", "/api/v1/queues/approvals", { as: finance });
const toApprove = ((endorsed.json?.data as { id: string }[]) ?? []).map((r) => r.id);
await swarm(toApprove.map((id) => async () => {
  await call("POST approve", "POST", `/api/v1/reimbursements/${id}/transitions`, {
    as: finance, body: { action: "APPROVE" }, expect: [200, 409],
  });
}), 40);

/*
 * `?group=none`. Grouped is the default — one person owed three things is one
 * transfer — and a group has a payee and an `items[]`, not an id. Asking for the
 * default and reading `.id` yields `undefined`, and the transition then answers
 * "Record not found", which is a long way from "you asked for the wrong shape".
 */
const payable = await call("GET /queues/payments", "GET", "/api/v1/queues/payments?group=none", { as: management });
const toPay = ((payable.json?.data as { kind: string; id: string }[]) ?? [])
  .filter((r) => r.kind === "REIMBURSEMENT")   // milestones settle on the vendor endpoint
  .map((r) => r.id);
await swarm(toPay.map((id) => async () => {
  await call("POST record payment", "POST", `/api/v1/reimbursements/${id}/transitions`, {
    as: management,
    body: { action: "RECORD_PAYMENT", payment_reference: `UTR-${randomBytes(4).toString("hex")}`, paid_at: "2026-11-25" },
    expect: [200, 409],
  });
}), 40);
console.log(`  endorsed queue → ${toApprove.length} approved → ${toPay.length} paid`);

/**
 * The places two people can collide.
 *
 * Not load — correctness under it. Each of these is a race the review found or the
 * design creates, fired deliberately rather than hoped for.
 */
phase("contention");

// One claim, many approvers. Exactly one may win.
const victim = toPay[0] ?? claims[0]?.id;
if (victim) {
  await call("POST reopen for race", "POST", `/api/v1/reimbursements/${victim}/transitions`, {
    as: finance, body: { action: "HOLD", reason: "staging a race" }, expect: [200, 409, 403],
  });
  await Promise.all(Array.from({ length: 20 }, () =>
    call("POST same-claim race", "POST", `/api/v1/reimbursements/${victim}/transitions`, {
      as: management, body: { action: "RESOLVE_HOLD", note: "race" }, expect: [200, 409, 403],
    })));
}

// Many reserve transfers at once — the fest-row lock, under real contention.
await Promise.all(budgetDepts.map((d) =>
  call("POST reserve race", "POST", "/api/v1/budget-transfers", {
    as: finance,
    body: { to_department_id: d, amount_paise: 500000, reason: "Simultaneous top-up" },
    expect: [200, 409],
  })));

// One key, ten simultaneous requests. One ticket, or the claim is false.
const dupKey = randomBytes(16).toString("hex");
const dupBody = {
  title: "Ten clicks on one button",
  description: "The same request, sent ten times at once, on purpose.",
  target_department_id: budgetDepts[0], due_at: "2026-11-27T16:00:00+05:30",
};
const dupResults = await Promise.all(Array.from({ length: 10 }, async () => {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/v1/tickets`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "Idempotency-Key": dupKey,
      "x-forwarded-for": "10.9.9.9", cookie: hods[0].cookie,
    },
    body: JSON.stringify(dupBody),
  });
  const j = await res.json().catch(() => null) as { id?: string } | null;
  samples.push({ op: "POST idempotency race", ms: performance.now() - t0, status: res.status, ok: [200, 201, 409].includes(res.status) });
  return j?.id;
}));
const madeIds = new Set(dupResults.filter(Boolean));
console.log(`  20 approvers on one claim · ${budgetDepts.length} reserve transfers · one key ×10 → ${madeIds.size} ticket(s)`);

/* -------------------------------------------------------------- the report */

const byOp = new Map<string, number[]>();
const failures = new Map<string, number>();
for (const s of samples) {
  if (!byOp.has(s.op)) byOp.set(s.op, []);
  byOp.get(s.op)!.push(s.ms);
  if (!s.ok) failures.set(`${s.op} → ${s.note ?? s.status}`, (failures.get(`${s.op} → ${s.note ?? s.status}`) ?? 0) + 1);
}


console.log(`\n  ${"operation".padEnd(30)} ${"n".padStart(6)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)} ${"max".padStart(8)}`);
console.log("  " + "─".repeat(72));
for (const [op, xs] of [...byOp.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(
    `  ${op.padEnd(30)} ${String(xs.length).padStart(6)} ${pctOf(xs, 0.5).toFixed(0).padStart(7)}ms `
    + `${pctOf(xs, 0.95).toFixed(0).padStart(7)}ms ${pctOf(xs, 0.99).toFixed(0).padStart(7)}ms `
    + `${Math.max(...xs).toFixed(0).padStart(7)}ms`,
  );
}

const total = samples.length;
const bad = samples.filter((s) => !s.ok).length;
console.log(`\n  ${total} calls in ${((Date.now() - started) / 1000).toFixed(1)}s · ${(total / ((Date.now() - started) / 1000)).toFixed(0)}/s · ${bad} not ok`);
if (failures.size) {
  console.log("\n  failures");
  for (const [k, n] of [...failures.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)} × ${k}`);
  }
}

/* ------------------------------------------------- did the books survive it */

const checks = (await db.execute(sql`
  select
    (select coalesce(sum(allocated_paise), 0) from departments where fest_id = ${festId})::bigint as allocated,
    (select total_budget_paise from fests where id = ${festId})::bigint                            as total,
    (select count(*) from reimbursement_requests where fest_id = ${festId})::int                   as claims,
    (select count(*) from tickets where fest_id = ${festId})::int                                  as tickets,
    (select count(*) from messages where fest_id = ${festId})::int                                 as messages,
    (select count(*) from audit_events where fest_id = ${festId})::int                             as audit,
    (select count(*) from users where fest_id = ${festId})::int                                    as users,
    (select count(*) from reimbursement_requests r where r.fest_id = ${festId}
       and r.status = 'PAID' and r.payment_reference is null)::int                                 as paid_without_reference,
    (select count(*) from (
        select entity_id from audit_events
         where fest_id = ${festId} and action = 'reimbursement.transition.RECORD_PAYMENT'
         group by entity_id having count(*) > 1) x)::int                                           as double_paid
`)) as unknown as Record<string, string>[];
const c = checks[0];

console.log("\n  capacity");
for (const r of curve) {
  console.log(`    ${String(r.at).padStart(4)} concurrent  ${(r.ops / r.seconds).toFixed(0).padStart(4)}/s  p50 ${r.p50.toFixed(0).padStart(4)}ms  p95 ${r.p95.toFixed(0).padStart(4)}ms  ${r.errors} errors`);
}

console.log("\n  the books");
console.log(`    users               ${c.users}`);
console.log(`    claims              ${c.claims}`);
console.log(`    tickets             ${c.tickets}`);
console.log(`    messages            ${c.messages}`);
console.log(`    audit events        ${c.audit}`);
console.log(`    allocated / total   ${c.allocated} / ${c.total}  ${Number(c.allocated) <= Number(c.total) ? "within" : "OVER — P0"}`);
console.log(`    paid with no UTR    ${c.paid_without_reference} ${Number(c.paid_without_reference) ? "— P0" : ""}`);
console.log(`    paid twice          ${c.double_paid} ${Number(c.double_paid) ? "— P0" : ""}`);

/* ------------------------------------------------------------------ flush */

if (FLUSH) {
  console.log("\n  flushing…");
  await dropFests(db, PREFIX);
  const left = (await db.execute(sql`
    select (select count(*) from fests where slug like ${PREFIX + "%"})::int as fests,
           (select count(*) from users u join fests f on f.id = u.fest_id
             where f.slug like ${PREFIX + "%"})::int as users`)) as unknown as Record<string, number>[];
  console.log(`  left behind: ${left[0].fests} fests, ${left[0].users} users`);
}

process.exit(bad > 0 ? 1 : 0);
