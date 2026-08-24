/**
 * `pnpm smoke` — drives every endpoint against a running server, over HTTP.
 *
 * Distinct from `tests/api/*`, which import the route handlers and call them in
 * process. That is faster and proves the permission matrix, but it never touches the
 * things between the socket and the handler: `proxy.ts`, the CSP, cookie flags,
 * redirects, streamed downloads. This does, because it is just a client.
 *
 * It builds a fest from nothing through the app's own API — departments, allocations,
 * people, a reimbursement taken to PAID, a vendor request, a ticket, income — and
 * reports what every endpoint answered. Then it puts the database back.
 *
 * Not a replacement for the test suite: it asserts far less, and its value is
 * breadth and realism rather than depth.
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";

const BASE = (process.env.SMOKE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const FEST_SLUG = `smoke-${randomBytes(4).toString("hex")}`;

const { db } = await import("../db/index.js");
const { sql } = await import("drizzle-orm");
const { dropFestBySlug } = await import("../lib/test-support.js");

/* ------------------------------------------------------------------ reporting */

const G = "\x1b[32m", R = "\x1b[31m", D = "\x1b[2m", O = "\x1b[0m";

interface Row {
  group: string;
  method: string;
  path: string;
  as: string;
  status: number;
  expected: string;
  ok: boolean;
  note?: string;
}

const rows: Row[] = [];
let group = "";
const section = (name: string) => { group = name; };

interface Session { name: string; cookie: string }
const anonymous: Session = { name: "anon", cookie: "" };

/**
 * Guards against the quietest failure mode in a script like this: an id that came
 * back empty from an earlier failed call, silently producing `/api/v1/x//y` — which
 * Next answers with a 308 redirect that then reads as a pass.
 */
function required(name: string, value: string): string {
  if (!value) {
    rows.push({
      group, method: "-", path: name, as: "-", status: 0, expected: "an id",
      ok: false, note: "an earlier call did not return one, so what follows is skipped",
    });
  }
  return value;
}

/** One request, recorded. `expect` is a status, a list, or a predicate. */
async function hit(
  method: string,
  path: string,
  opts: {
    as?: Session;
    body?: unknown;
    expect?: number | number[] | ((s: number) => boolean);
    label?: string;
    raw?: boolean;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> | null; text: string; headers: Headers }> {
  const as = opts.as ?? anonymous;

  // `//` in a path means an id was empty upstream. Record it rather than follow it.
  if (/\/\//.test(path.replace(/^https?:\/\//, ""))) {
    rows.push({
      group, method, path: opts.label ?? path, as: as.name,
      status: 0, expected: "-", ok: false, note: "skipped: an id was missing",
    });
    return { status: 0, json: null, text: "", headers: new Headers() };
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(as.cookie ? { cookie: as.cookie } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });

  const text = opts.raw ? "" : await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* not JSON: a download or a redirect */ }

  const expect = opts.expect ?? ((s: number) => s >= 200 && s < 400);
  const ok = typeof expect === "number" ? res.status === expect
    : Array.isArray(expect) ? expect.includes(res.status)
    : expect(res.status);

  const error = (json?.error ?? null) as { code?: string; message?: string } | null;
  rows.push({
    group,
    method,
    path: opts.label ?? path,
    as: as.name,
    status: res.status,
    expected: typeof expect === "number" ? String(expect)
      : Array.isArray(expect) ? expect.join("/") : "2xx/3xx",
    ok,
    note: ok ? error?.code : (error?.message ?? text.slice(0, 90)),
  });

  return { status: res.status, json, text, headers: res.headers };
}

/* -------------------------------------------------------------------- sign-in */

/**
 * Plants a sign-in token and follows the real callback, so the cookie, the session
 * row and the redirect are all exercised. The raw token never leaves the server
 * normally — only its hash is stored — so the smoke test writes its own.
 */
async function signIn(name: string, userId: string): Promise<Session> {
  const raw = `smoke-${randomBytes(24).toString("base64url")}`;
  await db.execute(sql`
    insert into sign_in_tokens (user_id, token_hash, expires_at)
    values (${userId}, ${createHash("sha256").update(raw).digest("hex")}, now() + interval '15 minutes')
  `);

  const res = await fetch(`${BASE}/auth/callback?token=${encodeURIComponent(raw)}`, {
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = /yg_session=([^;]+)/.exec(setCookie);

  rows.push({
    group: "Auth",
    method: "GET",
    path: "/auth/callback?token=…",
    as: name,
    status: res.status,
    expected: "307",
    ok: res.status === 307 && Boolean(match),
    note: match
      ? `httpOnly=${/httponly/i.test(setCookie)} sameSite=${/samesite=(\w+)/i.exec(setCookie)?.[1] ?? "?"}`
      : "no session cookie",
  });

  if (!match) throw new Error(`could not sign in as ${name}`);
  return { name, cookie: `yg_session=${match[1]}` };
}

const one = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> =>
  ((await db.execute(q)) as unknown as T[])[0];

/* ---------------------------------------------------------------- the fixture */

console.log(`\nSmoke test against ${BASE}\n${D}building fest ${FEST_SLUG}${O}\n`);

const health = await fetch(`${BASE}/sign-in`).catch(() => null);
if (!health?.ok) {
  console.error(`\n  ${BASE} is not answering. Start it with \`pnpm dev\` or \`pnpm start\`.\n`);
  process.exit(1);
}

const fest = await one<{ id: string }>(sql`
  insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end,
                     total_budget_paise, settings)
  values ('Smoke Fest', ${FEST_SLUG}, '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 0,
          '{"line_item_doc_threshold_paise": 1000000}'::jsonb)
  returning id`);

const mkDept = async (name: string, slug: string, kind: string) =>
  (await one<{ id: string }>(sql`
    insert into departments (fest_id, name, slug, kind, allocated_paise)
    values (${fest.id}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, 0)
    returning id`)).id;

const financeDeptId = await mkDept("Finance", "finance", "FINANCE");
const coreDeptId = await mkDept("Core", "core", "CORE");

const mkUser = async (name: string, role: string, departmentId: string, superAdmin = false) =>
  (await one<{ id: string }>(sql`
    insert into users (fest_id, name, email, role, department_id, status, upi_id, is_super_admin)
    values (${fest.id}, ${name}, ${`${randomBytes(6).toString("hex")}@sst.scaler.com`},
            ${sql.raw(`'${role}'::user_role`)}, ${departmentId}, 'ACTIVE', 'x@upi', ${superAdmin})
    returning id`)).id;

// An administrator, mirroring the bootstrap: the audit log and the close-out pack
// answer to that flag rather than to a role.
const financeId = await mkUser("Finance HOD", "FINANCE_HOD", financeDeptId, true);
const mgmtId = await mkUser("Management", "MANAGEMENT", coreDeptId);

await db.execute(sql`
  insert into expense_types (fest_id, name) values (${fest.id}, 'Equipment Rental')`);
const expenseTypeId = (await one<{ id: string }>(sql`
  select id from expense_types where fest_id = ${fest.id} limit 1`)).id;

section("Auth");
const finance = await signIn("finance", financeId);
const management = await signIn("mgmt", mgmtId);

await hit("GET", "/api/v1/me", { as: anonymous, expect: 401 });
await hit("POST", "/api/v1/auth/request-link", {
  body: { email: "nobody@sst.scaler.com" }, expect: 200, label: "/api/v1/auth/request-link (unknown)",
});

/* ------------------------------------------------------------------- the walk */

section("Me, fest, admin");
await hit("GET", "/api/v1/me", { as: finance });
await hit("PATCH", "/api/v1/me", { as: finance, body: { upi_id: "smoke@upi" } });
await hit("GET", "/api/v1/fest", { as: finance });
await hit("PATCH", "/api/v1/fest", {
  as: finance, body: { total_budget_paise: 5000000000, reason: "Smoke test opening budget" },
});
await hit("PATCH", "/api/v1/fest/settings", { as: finance, body: { request_aging_amber_days: 4 } });
await hit("GET", "/api/v1/expense-types", { as: finance });
await hit("POST", "/api/v1/expense-types", { as: finance, body: { name: `Smoke ${randomBytes(3).toString("hex")}` } });
await hit("PATCH", `/api/v1/expense-types/${expenseTypeId}`, {
  as: finance, body: { is_active: true }, label: "/api/v1/expense-types/{id}",
});
await hit("GET", "/api/v1/users", { as: finance });

section("Departments and budget");
const dept = await hit("POST", "/api/v1/departments", {
  as: finance, body: { name: "Tech", slug: `tech-${randomBytes(3).toString("hex")}`, allocated_paise: 0 },
});
const techId = required("department id", String(dept.json?.id ?? ""));
await hit("GET", "/api/v1/departments", { as: finance });
await hit("PATCH", `/api/v1/departments/${techId}`, {
  as: finance, body: { name: "Tech" }, label: "/api/v1/departments/{id}",
});
await hit("POST", "/api/v1/budget-transfers", {
  as: finance, body: { to_department_id: techId, amount_paise: 4000000000, reason: "Opening allocation" },
});
await hit("GET", "/api/v1/budget-transfers", { as: finance });
await hit("GET", `/api/v1/departments/${techId}/summary`, { as: finance, label: "/api/v1/departments/{id}/summary" });

section("Line items");
const li = await hit("POST", `/api/v1/departments/${techId}/line-items`, {
  as: finance, body: { name: "Sound system", planned_paise: 2000000000 },
  label: "/api/v1/departments/{id}/line-items",
});
const lineItemId = required("line item id", String(li.json?.id ?? ""));
await hit("GET", `/api/v1/departments/${techId}/line-items`, {
  as: finance, label: "/api/v1/departments/{id}/line-items",
});
await hit("GET", `/api/v1/line-items/${lineItemId}`, { as: finance, label: "/api/v1/line-items/{id}" });
await hit("PATCH", `/api/v1/line-items/${lineItemId}`, {
  as: finance, body: { description: "Main stage PA" }, label: "/api/v1/line-items/{id}",
});
const doc = await hit("POST", `/api/v1/line-items/${lineItemId}/documents`, {
  as: finance,
  body: { kind: "LINK", url: "https://example.com/quote", label: "Quotation — ABC Sound", quoted_amount_paise: 1900000000 },
  label: "/api/v1/line-items/{id}/documents",
});
const docId = required("document id", String(doc.json?.id ?? ""));
await hit("GET", `/api/v1/line-items/${lineItemId}/documents`, { as: finance, label: "/api/v1/line-items/{id}/documents" });
await hit("PATCH", `/api/v1/line-items/${lineItemId}/documents/${docId}`, {
  as: finance, body: { label: "Quotation — ABC Sound (rev 2)" },
  label: "/api/v1/line-items/{id}/documents/{aid}",
});
await hit("POST", `/api/v1/line-items/${lineItemId}/transitions`, {
  as: finance, body: { action: "MARK_REVIEWED" }, label: "/api/v1/line-items/{id}/transitions",
});
await hit("GET", "/api/v1/budget-review", { as: finance });

section("Attachments");
const presigned = await hit("POST", "/api/v1/attachments/presign", {
  as: finance, body: { purpose: "RECEIPT", file_name: "receipt.jpg", mime_type: "image/jpeg", size_bytes: 2048 },
});
const attachmentId = required("attachment id", String(presigned.json?.attachment_id ?? ""));
const uploadUrl = String(presigned.json?.upload_url ?? "");
const usingR2 = uploadUrl.startsWith("http");

if (!uploadUrl) {
  rows.push({
    group: "Attachments", method: "PUT", as: "finance", path: "upload",
    status: 0, expected: "200", ok: false, note: "skipped: presign returned no URL",
  });
} else {
  const put = await fetch(usingR2 ? uploadUrl : `${BASE}${uploadUrl}`, {
    method: "PUT", body: new Uint8Array(randomBytes(2048)),
  });
  rows.push({
    group: "Attachments", method: "PUT", as: "finance",
    path: usingR2 ? "R2 presigned PUT" : "/api/v1/attachments/upload (local)",
    status: put.status, expected: "200", ok: put.ok,
    note: usingR2 ? "cloudflare r2" : "local disk fallback",
  });
}

await hit("POST", `/api/v1/attachments/${attachmentId}/complete`, { as: finance, label: "/api/v1/attachments/{id}/complete" });
await hit("GET", `/api/v1/attachments/${attachmentId}`, { as: finance, label: "/api/v1/attachments/{id}" });
await hit("GET", `/api/v1/attachments/${attachmentId}/url`, { as: finance, label: "/api/v1/attachments/{id}/url" });
await hit("POST", "/api/v1/attachments", {
  as: finance,
  body: { kind: "LINK", purpose: "QUOTE", url: "https://example.com/listing", label: "A listing" },
});

section("Reimbursements");
const receiptFor = async () => {
  const p = await hit("POST", "/api/v1/attachments/presign", {
    as: finance, body: { purpose: "RECEIPT", file_name: "r.jpg", mime_type: "image/jpeg", size_bytes: 1024 },
    label: "/api/v1/attachments/presign",
  });
  const url = String(p.json?.upload_url ?? "");
  if (!url) return "";
  await fetch(url.startsWith("http") ? url : `${BASE}${url}`, {
    method: "PUT", body: new Uint8Array(randomBytes(1024)),
  });
  await hit("POST", `/api/v1/attachments/${p.json?.attachment_id}/complete`, {
    as: finance, label: "/api/v1/attachments/{id}/complete",
  });
  return String(p.json?.attachment_id ?? "");
};

const claim = await hit("POST", "/api/v1/reimbursements", {
  as: finance,
  body: {
    line_item_id: lineItemId, expense_type_id: expenseTypeId,
    description: "Cables and gaffer tape for the main stage",
    transaction_on: "2026-11-20", amount_paise: 250000,
    payee_name: "Finance HOD", payee_upi_id: "smoke@upi",
    attachment_ids: [await receiptFor()], submit: true,
  },
});
const claimId = required("reimbursement id", String(claim.json?.id ?? ""));
await hit("GET", "/api/v1/reimbursements", { as: finance });
await hit("GET", `/api/v1/reimbursements/${claimId}`, { as: finance, label: "/api/v1/reimbursements/{id}" });

// The claim is against Tech's budget, so Tech's HOD endorses it first (7.2) — and
// then Management approves, because the submitter is the Finance HOD (5.2).
const techHod = await signIn("tech-hod", await mkUser("Tech HOD", "DEPT_HOD", techId));
await hit("POST", `/api/v1/reimbursements/${claimId}/transitions`, {
  as: techHod, body: { action: "ENDORSE" }, label: "/api/v1/reimbursements/{id}/transitions ENDORSE",
});
await hit("POST", `/api/v1/reimbursements/${claimId}/transitions`, {
  as: finance, body: { action: "APPROVE" },
  expect: 403, label: "/api/v1/reimbursements/{id}/transitions APPROVE (own claim, 5.2)",
});
await hit("POST", `/api/v1/reimbursements/${claimId}/transitions`, {
  as: management, body: { action: "APPROVE" }, label: "/api/v1/reimbursements/{id}/transitions APPROVE",
});
await hit("POST", `/api/v1/reimbursements/${claimId}/transitions`, {
  as: management,
  body: { action: "RECORD_PAYMENT", payment_reference: "UTR-SMOKE", paid_at: "2026-11-25" },
  label: "/api/v1/reimbursements/{id}/transitions RECORD_PAYMENT",
});
await hit("POST", "/api/v1/reimbursements/bulk-approve", {
  as: finance, body: { ids: [claimId] },
});

section("Vendors");
const vendor = await hit("POST", "/api/v1/vendors", {
  as: finance, body: { name: `ABC Sound ${randomBytes(3).toString("hex")}`, upi_id: "abc@upi" },
});
const vendorId = required("vendor id", String(vendor.json?.id ?? ""));
await hit("GET", "/api/v1/vendors", { as: finance });
await hit("GET", `/api/v1/vendors/${vendorId}`, { as: finance, label: "/api/v1/vendors/{id}" });
await hit("PATCH", `/api/v1/vendors/${vendorId}`, {
  as: finance, body: { contact_name: "Ravi" }, label: "/api/v1/vendors/{id}",
});
const vr = await hit("POST", "/api/v1/vendor-requests", {
  as: finance,
  body: {
    vendor_id: vendorId, line_item_id: lineItemId, description: "Main stage PA for three days",
    total_value_paise: 10000000,
    milestones: [{ kind: "ADVANCE", planned_paise: 4000000 }, { kind: "BALANCE", planned_paise: 6000000 }],
    expected_delivery_on: "2026-11-26", submit: false,
  },
});
const vrId = required("vendor request id", String(vr.json?.id ?? ""));
await hit("GET", "/api/v1/vendor-requests", { as: finance });
await hit("GET", `/api/v1/vendor-requests/${vrId}`, { as: finance, label: "/api/v1/vendor-requests/{id}" });
await hit("PATCH", `/api/v1/vendor-requests/${vrId}`, {
  as: finance, body: { description: "Main stage PA, three days, with an engineer" },
  label: "/api/v1/vendor-requests/{id}",
});
await hit("POST", `/api/v1/vendor-requests/${vrId}/transitions`, {
  as: finance, body: { action: "SUBMIT" }, label: "/api/v1/vendor-requests/{id}/transitions SUBMIT",
});

section("Income");
const income = await hit("POST", "/api/v1/income", {
  as: finance,
  body: { type: "SPONSORSHIP_CASH", source_name: "Acme Corp", pledged_paise: 5000000, pledged_on: "2026-09-01" },
});
const incomeId = required("income id", String(income.json?.id ?? ""));
await hit("GET", "/api/v1/income", { as: finance });
await hit("GET", "/api/v1/income/summary", { as: finance });
await hit("GET", `/api/v1/income/${incomeId}`, { as: finance, label: "/api/v1/income/{id}" });
await hit("PATCH", `/api/v1/income/${incomeId}`, {
  as: finance, body: { notes: "Signed MoU pending" }, label: "/api/v1/income/{id}",
});
await hit("POST", `/api/v1/income/${incomeId}/tranches`, {
  as: finance, body: { amount_paise: 2000000, received_on: "2026-09-20", reference: "NEFT-1" },
  label: "/api/v1/income/{id}/tranches",
});
await hit("GET", `/api/v1/income/${incomeId}/statement`, { as: finance, label: "/api/v1/income/{id}/statement" });
await hit("POST", `/api/v1/income/${incomeId}/transitions`, {
  as: finance, body: { action: "WRITE_OFF", reason: "Sponsor withdrew" },
  label: "/api/v1/income/{id}/transitions",
});

section("Tickets");
const ticket = await hit("POST", "/api/v1/tickets", {
  as: finance,
  body: {
    title: "40 chairs to Audi B before 4pm",
    description: "Stacked at the back entrance is fine.",
    target_department_id: techId, due_at: "2026-11-27T16:00:00+05:30", priority: "HIGH",
  },
});
const ticketId = required("ticket id", String(ticket.json?.id ?? ""));
await hit("GET", "/api/v1/tickets?view=outgoing", { as: finance });
await hit("GET", "/api/v1/tickets/counts", { as: finance });
await hit("GET", "/api/v1/tickets/workload", { as: finance });
await hit("GET", `/api/v1/tickets/similar?target_department_id=${techId}&title=chairs%20to%20audi`, {
  as: finance, label: "/api/v1/tickets/similar",
});
await hit("GET", `/api/v1/tickets/${ticketId}`, { as: finance, label: "/api/v1/tickets/{id}" });
await hit("PATCH", `/api/v1/tickets/${ticketId}`, {
  as: finance, body: { description: "Stacked at the back entrance is fine, any time before 4." },
  label: "/api/v1/tickets/{id}",
});
await hit("POST", `/api/v1/tickets/${ticketId}/watchers/${financeId}`, {
  as: finance, label: "/api/v1/tickets/{id}/watchers/{self}",
});
await hit("DELETE", `/api/v1/tickets/${ticketId}/watchers/${financeId}`, {
  as: finance, label: "/api/v1/tickets/{id}/watchers/{self}",
});
// 20.9 — putting somebody else on a ticket is the target department HOD's call.
await hit("POST", `/api/v1/tickets/${ticketId}/watchers/${mgmtId}`, {
  as: finance, expect: 403, label: "/api/v1/tickets/{id}/watchers/{other} (refused)",
});
await hit("POST", `/api/v1/tickets/${ticketId}/links`, {
  as: finance, body: { to_type: "REIMBURSEMENT", to_id: claimId },
  label: "/api/v1/tickets/{id}/links",
});
await hit("POST", `/api/v1/tickets/${ticketId}/transitions`, {
  as: finance, body: { action: "CANCEL", reason: "Smoke test tidy-up" },
  label: "/api/v1/tickets/{id}/transitions",
});

section("Comments, flags, audit, notifications");
await hit("POST", "/api/v1/comments", {
  as: finance, body: { entity_type: "REIMBURSEMENT", entity_id: claimId, body: "Checked against the quote." },
});
const comments = await hit("GET", `/api/v1/comments?entity_type=REIMBURSEMENT&entity_id=${claimId}`, {
  as: finance, label: "/api/v1/comments",
});
const commentId = String((comments.json?.data as { id: string }[] | undefined)?.[0]?.id ?? "");
if (commentId) {
  await hit("PATCH", `/api/v1/comments/${commentId}`, {
    as: finance, body: { body: "Checked against the lowest quote." }, label: "/api/v1/comments/{id}",
  });
}
await hit("POST", "/api/v1/flags/evaluate", {
  as: finance, body: { entity_type: "LINE_ITEM", entity_id: lineItemId },
});
const flags = await hit("GET", "/api/v1/flags", { as: finance });
const flagId = String((flags.json?.data as { id: string }[] | undefined)?.[0]?.id ?? "");
if (flagId) {
  await hit("POST", `/api/v1/flags/${flagId}/transitions`, {
    as: finance, body: { action: "ACKNOWLEDGE", note: "Quotes are attached; this is expected." },
    label: "/api/v1/flags/{id}/transitions",
  });
}
await hit("GET", "/api/v1/audit", { as: finance });
await hit("GET", "/api/v1/notifications", { as: finance });
await hit("POST", "/api/v1/notifications/read", { as: finance, body: {} });
await hit("POST", "/api/v1/notifications/read-all", { as: finance, body: {} });

section("Dashboards and queues");
await hit("GET", "/api/v1/dashboard/fest", { as: finance });
await hit("GET", "/api/v1/dashboard/me", { as: finance });
await hit("GET", `/api/v1/dashboard/department/${techId}`, { as: finance, label: "/api/v1/dashboard/department/{id}" });
await hit("GET", "/api/v1/queues/endorsements", { as: finance });
await hit("GET", "/api/v1/queues/approvals", { as: finance });
await hit("GET", "/api/v1/queues/payments", { as: management });

section("Exports");
for (const kind of ["transactions", "payment-batch", "vendor-ledger", "income-ledger", "audit"]) {
  await hit("GET", `/api/v1/exports/${kind}?format=csv`, { as: finance, label: `/api/v1/exports/${kind} (csv)` });
}
for (const kind of ["fest-summary", "vendor-ledger"]) {
  await hit("GET", `/api/v1/exports/${kind}?format=xlsx`, { as: finance, label: `/api/v1/exports/${kind} (xlsx)`, raw: true });
}
await hit("GET", `/api/v1/exports/department-statement?id=${techId}&format=html`, {
  as: finance, label: "/api/v1/exports/department-statement (print)",
});
await hit("GET", `/api/v1/exports/sponsor-statement?id=${incomeId}&format=html`, {
  as: finance, label: "/api/v1/exports/sponsor-statement (print)",
});

section("Cron");
const cronSecret = process.env.CRON_SECRET ?? "";
for (const job of ["ticket-sla", "vendor-overdue", "income-followups", "gc-attachments", "daily-digest", "outbox"]) {
  const res = await fetch(`${BASE}/api/v1/cron/${job}`, {
    method: "POST", headers: { authorization: `Bearer ${cronSecret}` },
  });
  const body = await res.json().catch(() => null);
  rows.push({
    group: "Cron", method: "POST", path: `/api/v1/cron/${job}`, as: "CRON_SECRET",
    status: res.status, expected: "200", ok: res.ok,
    note: body?.ok === true ? `${body.ms ?? "?"}ms` : JSON.stringify(body)?.slice(0, 60),
  });
}
await hit("POST", "/api/v1/cron/ticket-sla", { as: anonymous, expect: 403, label: "/api/v1/cron/* (no secret)" });

section("Pages");
await hit("GET", "/sign-in", { as: finance, expect: 307, label: "/sign-in (already signed in)" });
for (const page of ["/dashboard", "/requests", "/tickets", "/budget", "/budget/review",
                    "/vendors", "/income", "/queues", "/flags", "/notifications", "/close-out",
                    "/audit", "/admin"]) {
  await hit("GET", page, { as: finance, expect: 200 });
}
await hit("GET", "/dashboard", { as: anonymous, expect: [307, 302], label: "/dashboard (anonymous)" });

// Oversight is the administrator flag's, not a role's. The target department's HOD
// is as senior as anyone gets without it, and must not reach either.
await hit("GET", "/audit", { as: techHod, expect: 404, label: "/audit (not an administrator)" });
await hit("GET", "/close-out", { as: techHod, expect: 404, label: "/close-out (not an administrator)" });
await hit("GET", "/api/v1/audit", { as: techHod, expect: 403, label: "/api/v1/audit (not an administrator)" });

section("Security headers");
const headers = (await fetch(`${BASE}/sign-in`)).headers;
for (const [name, test] of [
  ["content-security-policy", (v: string) => v.includes("frame-ancestors 'none'")],
  ["x-frame-options", (v: string) => v === "DENY"],
  ["x-content-type-options", (v: string) => v === "nosniff"],
  ["referrer-policy", (v: string) => v.includes("strict-origin")],
  ["permissions-policy", (v: string) => v.includes("microphone=()")],
] as const) {
  const value = headers.get(name) ?? "";
  rows.push({
    group: "Security headers", method: "GET", path: name, as: "-",
    status: value ? 200 : 0, expected: "present", ok: Boolean(value) && test(value),
    note: value.slice(0, 60) || "absent",
  });
}

/* --------------------------------------------------------------------- report */

await dropFestBySlug(db, FEST_SLUG);

const width = Math.max(...rows.map((r) => r.path.length)) + 2;
let lastGroup = "";
for (const row of rows) {
  if (row.group !== lastGroup) {
    console.log(`\n${row.group}`);
    lastGroup = row.group;
  }
  const mark = row.ok ? `${G}✓${O}` : `${R}✗${O}`;
  const status = row.ok ? `${D}${row.status}${O}` : `${R}${row.status} (want ${row.expected})${O}`;
  console.log(
    `  ${mark} ${row.method.padEnd(6)} ${row.path.padEnd(width)} ${D}${row.as.padEnd(10)}${O} ${status}`
    + (row.note ? `  ${D}${row.note}${O}` : ""),
  );
}

const failed = rows.filter((r) => !r.ok);
console.log(`\n${"─".repeat(72)}`);
console.log(`  ${rows.length} calls  ${G}${rows.length - failed.length} ok${O}`
  + (failed.length ? `  ${R}${failed.length} failed${O}` : ""));

if (failed.length) {
  console.log(`\n${R}Failures${O}`);
  for (const f of failed) console.log(`  ${f.method} ${f.path} as ${f.as} → ${f.status}  ${f.note ?? ""}`);
}
console.log();

process.exit(failed.length ? 1 : 0);
