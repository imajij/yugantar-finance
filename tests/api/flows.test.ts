/**
 * The core flows driven through the HTTP layer (PRD 21.3).
 *
 * `tests/db/*` already prove the services and the arithmetic. What these add is
 * everything *between* the request and the service: body parsing, the 20.1 error
 * shape, `Idempotency-Key`, the attachment visibility gate, and the notifications
 * that a write is supposed to leave behind. Those are all in the route layer, and
 * a service-level test cannot see any of them.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { dropFests } from "@/lib/test-support";
import { buildFixture, callAs, type Fixture, type Handler } from "./harness";

const PREFIX = "apiflow-";
let fx: Fixture;

beforeAll(async () => {
  fx = await buildFixture(PREFIX);
});

afterAll(() => dropFests(db, PREFIX));

const load = (path: string) => import(`@/app/api/v1/${path}/route`) as Promise<Record<string, Handler>>;

/**
 * A refusal, however it is spelled. `can()` says FORBIDDEN; the transition table
 * says INVALID_TRANSITION when the actor's role is not on the transition at all
 * (18.2 rule 2, checked first). Both mean "no", and which one surfaces depends on
 * which gate the caller hits — that is an implementation detail, not a contract.
 */
const REFUSED = ["FORBIDDEN", "INVALID_TRANSITION"];

/** An uploaded, completed receipt belonging to `userId`, ready to bind. */
async function receipt(userId: string): Promise<string> {
  const [row] = (await db.execute(sql`
    insert into attachments (fest_id, purpose, kind, storage_key, file_name, mime_type,
                             size_bytes, sha256, uploaded_by)
    values (${fx.festId}, 'RECEIPT', 'FILE', ${`k/${crypto.randomUUID()}`}, 'receipt.jpg',
            'image/jpeg', 1024, ${crypto.randomUUID()}, ${userId})
    returning id`)) as unknown as { id: string }[];
  return row.id;
}

/**
 * A distinct claim each time. F1 flags a repeat of the same amount + date + merchant
 * as a duplicate receipt, and rightly so — but a fixture that reuses one set of
 * details makes every test after the first fight a High flag it never meant to
 * create. Varying the merchant is enough to keep them genuinely different.
 */
let claimCount = 0;
const newRequest = (attachmentId: string, overrides: Record<string, unknown> = {}) => {
  claimCount += 1;
  return {
    line_item_id: fx.lineItemId,
    expense_type_id: fx.expenseTypeId,
    description: "Cables and gaffer tape for the main stage",
    transaction_on: "2026-11-20",
    amount_paise: 250000 + claimCount,
    merchant: `Sound Works ${claimCount}`,
    payee_name: "Tech Member",
    payee_upi_id: `payee-${claimCount}@upi`,
    attachment_ids: [attachmentId],
    ...overrides,
  };
};

/* ---------------------------------------------------- who endorses (PRD 7.2) */

test("a Dept HOD cannot even reach another department's line item", async () => {
  const create = (await load("reimbursements")).POST;

  // `lineItem.view` is the gate: a Tech HOD has no business spending Logistics'
  // allocation, so the claim never gets as far as a routing decision.
  const created = await callAs(fx.users.hod, create, {
    method: "POST",
    body: { ...newRequest(await receipt(fx.users.hod.id), { line_item_id: fx.otherLineItemId }), submit: true },
  });
  expect(created.code).toBe("FORBIDDEN");
});

test("a Finance HOD spending another department's budget is still endorsed by them", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  // Finance can see every line item, so this one does reach the routing decision.
  // It must land in SUBMITTED: routing on role alone would let Finance spend Tech's
  // allocation with the Tech HOD never seeing it.
  const created = await callAs(fx.users.finance, create, {
    method: "POST",
    body: { ...newRequest(await receipt(fx.users.finance.id), { line_item_id: fx.lineItemId }), submit: true },
  });
  expect(created.status).toBe(200);
  expect(created.json!.status).toBe("SUBMITTED");

  const id = String(created.json!.id);
  expect((await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
  })).json!.status).toBe("HOD_ENDORSED");
});

test("an HOD spending their own department's budget is never left unendorsable", async () => {
  const create = (await load("reimbursements")).POST;

  // Nobody may endorse their own request, and a fest has one Finance HOD — so if
  // this landed in SUBMITTED there would be no one able to move it at all.
  for (const [who, lineItemId] of [
    [fx.users.hod, fx.lineItemId],
    [fx.users.finance, fx.financeLineItemId],
  ] as const) {
    const created = await callAs(who, create, {
      method: "POST",
      body: { ...newRequest(await receipt(who.id), { line_item_id: lineItemId }), submit: true },
    });
    expect(created.status, `${who.role} submitting against their own department`).toBe(200);
    expect(created.json!.status).toBe("HOD_ENDORSED");
  }
});

/* -------------------------------------------------------- the reimbursement flow */

test("submit → endorse → approve → pay, each step by the role that owns it", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;
  const detail = (await load("reimbursements/[id]")).GET;

  const created = await callAs(fx.users.member, create, {
    method: "POST",
    body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  expect(created.status).toBe(200);
  const id = String(created.json!.id);
  expect(created.json!.status).toBe("SUBMITTED");
  expect(String(created.json!.humanId)).toMatch(/^RB-\d{4}$/);

  // 5.2 — the submitter may not endorse their own request.
  const selfEndorse = await callAs(fx.users.member, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
  });
  expect(REFUSED).toContain(selfEndorse.code);

  // Nor may the HOD of a different department.
  const wrongHod = await callAs(fx.users.otherHod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
  });
  expect(wrongHod.code).toBe("FORBIDDEN");

  const endorsed = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
  });
  expect(endorsed.json!.status).toBe("HOD_ENDORSED");

  // Management does not approve an ordinary member's request; Finance does (7.2).
  // The transition table rejects the role before `can` is consulted, so this comes
  // back as INVALID_TRANSITION rather than FORBIDDEN — both are refusals, and the
  // table is checked first by design (18.2 rule 2).
  const wrongApprover = await callAs(fx.users.management, transitions, {
    method: "POST", params: { id }, body: { action: "APPROVE" },
  });
  expect(REFUSED).toContain(wrongApprover.code);

  const approved = await callAs(fx.users.finance, transitions, {
    method: "POST", params: { id }, body: { action: "APPROVE" },
  });
  expect(approved.json!.status).toBe("APPROVED");

  // Finance approves; Management pays. Neither does the other's job (5.2).
  const financePays = await callAs(fx.users.finance, transitions, {
    method: "POST", params: { id },
    body: { action: "RECORD_PAYMENT", payment_reference: "UTR123", paid_at: "2026-11-25" },
  });
  expect(REFUSED).toContain(financePays.code);

  const paid = await callAs(fx.users.management, transitions, {
    method: "POST", params: { id },
    body: { action: "RECORD_PAYMENT", payment_reference: "UTR123", paid_at: "2026-11-25" },
  });
  expect(paid.json!.status).toBe("PAID");

  // 20.1 — one call returns the record plus its attachments, flags, comments and timeline.
  const full = await callAs(fx.users.member, detail, { params: { id } });
  expect(full.status).toBe(200);
  expect(Array.isArray(full.json!.timeline)).toBe(true);
  expect((full.json!.timeline as unknown[]).length).toBeGreaterThanOrEqual(4);
});

test("a request the caller has nothing to do with is not readable", async () => {
  const create = (await load("reimbursements")).POST;
  const detail = (await load("reimbursements/[id]")).GET;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);

  const other = await callAs(fx.users.otherMember, detail, { params: { id } });
  expect(other.code).toBe("FORBIDDEN");
});

/* ------------------------------------------------------------------ idempotency */

/** How many times this claim was actually endorsed, whatever the responses said. */
async function endorsements(id: string): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as n from audit_events
     where entity_type = 'REIMBURSEMENT' and entity_id = ${id}
       and action = 'reimbursement.transition.ENDORSE'`);
  return Number((rows as unknown as { n: number }[])[0].n);
}

test("a repeated Idempotency-Key returns the original response, not a second write", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);
  const key = crypto.randomUUID();

  const first = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  expect(first.json!.status).toBe("HOD_ENDORSED");

  // Replayed: same key, same answer — and crucially not an INVALID_TRANSITION,
  // which is what a naive retry would get once the state had already moved.
  const replay = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  expect(replay.status).toBe(200);
  expect(replay.json!.id).toBe(id);
  expect(replay.json!.status).toBe("HOD_ENDORSED");

  // Without the key, the same call is a genuine second attempt and is refused.
  const retry = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
  });
  expect(retry.code).toBe("INVALID_TRANSITION");

  // 20.1 — a key belongs to whoever first used it.
  const stolen = await callAs(fx.users.finance, transitions, {
    method: "POST", params: { id }, body: { action: "APPROVE" },
    headers: { "Idempotency-Key": key },
  });
  expect(stolen.code).toBe("CONFLICT");
});

/**
 * The half the test above cannot see: a key that is already claimed.
 *
 * The old implementation read the key, ran the handler, and wrote the key
 * afterwards — so a serial retry replayed correctly (which is what the test above
 * proves) and a concurrent one did not. Both found no row, both ran, and the
 * loser's response was dropped. That is a double-click or a retry on a flaky
 * connection, and on these routes it is a second payment.
 *
 * Set up rather than raced. Firing two requests together and hoping they interleave
 * at the right instruction passes on a quiet machine for the wrong reason — it did,
 * against the very bug it was written for. So the reservation is written first,
 * exactly as the wrapper writes one, and the request then has to meet it.
 */
test("a key already claimed by a request in flight does not run again", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);
  const key = crypto.randomUUID();

  // Claimed, not yet finished: `response` is null while the work is running.
  await db.execute(sql`
    insert into idempotency_keys (key, user_id, response, fingerprint)
    values (${key}, ${fx.users.hod.id}, null, null)`);

  const blocked = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  expect(blocked.code).toBe("CONFLICT");
  expect(blocked.message).toMatch(/still being processed/i);

  // The point of all of it: the record did not move.
  expect(await endorsements(id)).toBe(0);
});

/**
 * The other side of a reservation: a request that claims a key and then dies leaves
 * the row pending for good. Without a way back, that key is unusable forever — the
 * caller retries, is told "still running", and stays told.
 */
test("a reservation left behind by a dead request is reclaimed", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);
  const key = crypto.randomUUID();

  await db.execute(sql`
    insert into idempotency_keys (key, user_id, response, fingerprint, created_at)
    values (${key}, ${fx.users.hod.id}, null, null, now() - interval '20 minutes')`);

  const retried = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  expect(retried.status).toBe(200);
  expect(retried.json!.status).toBe("HOD_ENDORSED");
});

/**
 * The real-world shape, kept for what it asserts rather than for what it proves:
 * however two simultaneous requests interleave, the record moves once. It is not
 * the regression test — the two above are — because the interleaving is the
 * scheduler's to decide.
 */
test("two requests with one key leave the record moved once", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);
  const key = crypto.randomUUID();

  const send = () => callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  const results = await Promise.all([send(), send(), send(), send()]);

  for (const r of results) {
    if (r.status === 200) expect(r.json!.status).toBe("HOD_ENDORSED");
    else expect(r.code).toBe("CONFLICT");
  }
  expect(await endorsements(id)).toBe(1);
});

test("a key cannot be reused for a different request", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  const first = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const second = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const key = crypto.randomUUID();

  await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id: String(first.json!.id) }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });

  /*
   * Same key, different claim. Replaying here would hand back the stored response
   * for the *first* request — the caller would be told the second one was endorsed,
   * with the first one's id in the body, and would have no way to know.
   */
  const reused = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id: String(second.json!.id) }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  expect(reused.code).toBe("CONFLICT");
  expect(reused.message).toMatch(/different request/i);
});

test("a failed attempt hands the key back", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);
  const key = crypto.randomUUID();

  // Refused: Finance cannot endorse a Tech claim at this point in the chain.
  const refused = await callAs(fx.users.member, transitions, {
    method: "POST", params: { id }, body: { action: "APPROVE" },
    headers: { "Idempotency-Key": key },
  });
  expect(refused.status).toBeGreaterThanOrEqual(400);

  /*
   * The same key must still work. A reservation that survived its own failure would
   * mean one refused attempt burns the key: the caller fixes whatever was wrong,
   * retries with the key their client generated for this action, and is told the
   * request is still being processed — forever.
   */
  const retried = await callAs(fx.users.hod, transitions, {
    method: "POST", params: { id }, body: { action: "ENDORSE" },
    headers: { "Idempotency-Key": key },
  });
  expect(retried.status).toBe(200);
  expect(retried.json!.status).toBe("HOD_ENDORSED");
});

/* ----------------------------------------------------------------- notifications */

test("a submission notifies the department HOD, in the inbox and the outbox", async () => {
  const create = (await load("reimbursements")).POST;

  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(await receipt(fx.users.member.id)), submit: true },
  });
  const id = String(created.json!.id);

  const rows = (await db.execute(sql`
    select channel::text as channel, recipient_id, title from notifications
     where entity_type = 'REIMBURSEMENT' and entity_id = ${id}
  `)) as unknown as { channel: string; recipient_id: string; title: string }[];

  const hodRows = rows.filter((r) => r.recipient_id === fx.users.hod.id);
  expect(hodRows.map((r) => r.channel).sort()).toEqual(["EMAIL", "IN_APP"]);
  expect(hodRows[0].title).toContain("needs your endorsement");

  // Nobody is told about their own action.
  expect(rows.some((r) => r.recipient_id === fx.users.member.id)).toBe(false);
});

/* ------------------------------------------------------------------- attachments */

test("an attachment URL is only ever issued to someone who can see the parent", async () => {
  const create = (await load("reimbursements")).POST;
  const url = (await load("attachments/[id]/url")).GET;

  const attachmentId = await receipt(fx.users.member.id);
  const created = await callAs(fx.users.member, create, {
    method: "POST", body: { ...newRequest(attachmentId), submit: true },
  });
  expect(created.status).toBe(200);

  const mine = await callAs(fx.users.member, url, { params: { id: attachmentId } });
  expect(mine.status).toBe(200);
  expect(String(mine.json!.url)).toContain("sig=");

  const hod = await callAs(fx.users.hod, url, { params: { id: attachmentId } });
  expect(hod.status).toBe(200);

  // A member of another department can see neither the request nor its receipt.
  const stranger = await callAs(fx.users.otherMember, url, { params: { id: attachmentId } });
  expect(stranger.code).toBe("FORBIDDEN");
});

test("an unbound upload belongs to its uploader and nobody else", async () => {
  const url = (await load("attachments/[id]/url")).GET;
  const attachmentId = await receipt(fx.users.member.id);

  expect((await callAs(fx.users.member, url, { params: { id: attachmentId } })).status).toBe(200);
  // Not even Finance, who can see every record, can reach a file with no record yet.
  expect((await callAs(fx.users.finance, url, { params: { id: attachmentId } })).code).toBe("FORBIDDEN");
});

test("a receipt cannot be bound to a second request", async () => {
  const create = (await load("reimbursements")).POST;
  const attachmentId = await receipt(fx.users.member.id);

  expect((await callAs(fx.users.member, create, {
    method: "POST", body: newRequest(attachmentId),
  })).status).toBe(200);

  const reused = await callAs(fx.users.member, create, {
    method: "POST", body: newRequest(attachmentId),
  });
  expect(reused.code).toBe("VALIDATION_ERROR");
});

/* ------------------------------------------------------------------ error shapes */

test("a malformed body produces the 20.1 validation shape, not a stack trace", async () => {
  const create = (await load("reimbursements")).POST;

  const bad = await callAs(fx.users.member, create, {
    method: "POST",
    body: { line_item_id: "not-a-uuid", amount_paise: -5, description: "short" },
  });
  expect(bad.status).toBe(422);
  expect(bad.code).toBe("VALIDATION_ERROR");
  const details = bad.json!.error as { details?: { issues?: { path: string }[] } };
  expect(details.details?.issues?.length).toBeGreaterThan(0);
  expect(bad.text).not.toContain("at Object.");
});

test("an over-allocation is a 409 with the numbers behind it", async () => {
  const create = (await load("departments/[id]/line-items")).POST;

  const over = await callAs(fx.users.hod, create, {
    method: "POST",
    params: { id: fx.departments.tech },
    body: { name: "Far too much", planned_paise: 999_000_000 },
  });
  expect(over.status).toBe(409);
  expect(over.code).toBe("OVER_ALLOCATION");
  const details = (over.json!.error as { details?: Record<string, number> }).details!;
  expect(details.allocated_paise).toBe(5000000);
  expect(details.over_by_paise).toBeGreaterThan(0);
});

/* ------------------------------------------------------------------------- flags */

test("a flag can be raised, listed, and resolved with a note that is audited", async () => {
  const evaluate = (await load("flags/evaluate")).POST;
  const list = (await load("flags")).GET;
  const resolve = (await load("flags/[id]/transitions")).POST;

  // The fixture's line items carry a quotation, so F13 does not fire on them. A
  // bare one over the ₹10,000 threshold is what F13 is for.
  const [bare] = (await db.execute(sql`
    insert into line_items (fest_id, department_id, name, planned_paise, created_by)
    values (${fx.festId}, ${fx.departments.tech}, 'Undocumented', 1500000, ${fx.users.finance.id})
    returning id`)) as unknown as { id: string }[];

  const evaluated = await callAs(fx.users.finance, evaluate, {
    method: "POST",
    body: { entity_type: "LINE_ITEM", entity_id: bare.id },
  });
  expect(evaluated.status).toBe(200);
  expect((evaluated.json!.flags as { rule: string }[]).map((f) => f.rule)).toContain("F13");

  const listed = await callAs(fx.users.finance, list, { query: { entity_type: "LINE_ITEM" } });
  const flag = (listed.json!.data as Record<string, string>[]).find((f) => f.entity_id === bare.id);
  expect(flag).toBeTruthy();

  // 8.3 — resolving without saying why is refused.
  const silent = await callAs(fx.users.finance, resolve, {
    method: "POST", params: { id: flag!.id }, body: { action: "ACKNOWLEDGE" },
  });
  expect(silent.code).toBe("VALIDATION_ERROR");

  const resolved = await callAs(fx.users.finance, resolve, {
    method: "POST",
    params: { id: flag!.id },
    body: { action: "ACKNOWLEDGE", note: "Quotes are on the shared drive; linking them tomorrow." },
  });
  expect(resolved.json!.status).toBe("ACKNOWLEDGED");

  const [audit] = (await db.execute(sql`
    select action, reason from audit_events
     where entity_id = ${bare.id} and action = 'flag.acknowledge'
     order by created_at desc limit 1
  `)) as unknown as { action: string; reason: string }[];
  expect(audit.reason).toContain("shared drive");
});

/* ------------------------------------------------------------------------ queues */

test("the payment queue groups by payee and never shows Management their own claim", async () => {
  const create = (await load("reimbursements")).POST;
  const transitions = (await load("reimbursements/[id]/transitions")).POST;
  const payments = (await load("queues/payments")).GET;

  // Management raises and pushes through a claim of their own.
  const own = await callAs(fx.users.management, create, {
    method: "POST",
    body: {
      ...newRequest(await receipt(fx.users.management.id)),
      payee_name: "Management", payee_upi_id: "mg@upi", submit: true,
    },
  });
  const ownId = String(own.json!.id);
  // A Management submission lands in SUBMITTED and is endorsed by the target HOD.
  await callAs(fx.users.hod, transitions, { method: "POST", params: { id: ownId }, body: { action: "ENDORSE" } });
  await callAs(fx.users.finance, transitions, { method: "POST", params: { id: ownId }, body: { action: "APPROVE" } });

  const queue = await callAs(fx.users.management, payments, { query: { group: "none" } });
  const ids = (queue.json!.data as { id: string }[]).map((r) => r.id);
  expect(ids, "5.2 — Management must never be able to pay themselves").not.toContain(ownId);

  const grouped = await callAs(fx.users.management, payments, {});
  const groups = grouped.json!.data as { payee_name: string; total_paise: number; items: unknown[] }[];
  for (const group of groups) {
    expect(group.total_paise).toBe(
      (group.items as { amount_paise: number }[]).reduce((t, i) => t + i.amount_paise, 0),
    );
  }
});

/* ----------------------------------------------------------------- rate limiting */

test("exports are rate limited, and the 429 says how long to wait", async () => {
  const exportRoute = (await load("exports/[kind]")).GET;

  // The export limit is 20 an hour; spend it, then check the refusal.
  let last = null as Awaited<ReturnType<typeof callAs>> | null;
  for (let i = 0; i < 22; i++) {
    last = await callAs(fx.users.finance, exportRoute, { params: { kind: "income-ledger" } });
    if (last.status === 429) break;
  }

  expect(last!.status).toBe(429);
  expect(last!.code).toBe("RATE_LIMITED");
  const details = (last!.json!.error as { details?: Record<string, number> }).details!;
  expect(details.retry_after_seconds).toBeGreaterThan(0);
});

/* -------------------------------------------------------------------- fest scope */

beforeEach(() => {
  // Nothing to reset: each test creates its own records inside the one fixture fest.
});

test("no endpoint accepts a fest id from the client (18.2 rule 10)", async () => {
  const otherFest = await buildFixture(PREFIX);
  const detail = (await load("reimbursements/[id]")).GET;
  const create = (await load("reimbursements")).POST;

  const theirs = await callAs(otherFest.users.member, create, {
    method: "POST",
    body: {
      line_item_id: otherFest.lineItemId,
      expense_type_id: otherFest.expenseTypeId,
      description: "Something in the other fest entirely",
      transaction_on: "2026-11-20",
      amount_paise: 100000,
      payee_name: "Someone", payee_upi_id: "s@upi",
      attachment_ids: [],
      submit: false,
    },
  });
  // No receipt: refused on its merits, which is fine — the id below is what matters.
  expect(theirs.code).toBe("VALIDATION_ERROR");

  const [row] = (await db.execute(sql`
    insert into reimbursement_requests
      (fest_id, human_id, department_id, line_item_id, expense_type_id, submitter_id,
       description, transaction_on, amount_paise, payee_name, payee_upi_id, status)
    values (${otherFest.festId}, 'RB-9999', ${otherFest.departments.tech}, ${otherFest.lineItemId},
            ${otherFest.expenseTypeId}, ${otherFest.users.member.id},
            'A request in another fest', '2026-11-20', 100000, 'Someone', 's@upi', 'SUBMITTED')
    returning id`)) as unknown as { id: string }[];

  // Finance of *this* fest, asking for a record in the other one, by its real id.
  const crossFest = await callAs(fx.users.finance, detail, { params: { id: row.id } });
  expect(crossFest.code).toBe("NOT_FOUND");
});
