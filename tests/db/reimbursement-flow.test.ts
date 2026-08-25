/**
 * PRD 21.3 — "the five numbers for a seeded department match a hand-computed fixture
 * after a scripted sequence: submit → endorse → approve → pay", plus the segregation
 * cases and the flags that fire along the way.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import type { Actor } from "@/lib/authz";
import { rupeesToPaise as R } from "@/lib/money";
import { createLineItem } from "@/lib/services/line-items";
import {
  createReimbursement, getReimbursementDetail, transitionReimbursement,
} from "@/lib/services/reimbursements";
import { departmentTotals, lineItemTotals } from "@/lib/queries/budget";
import { stalledStages } from "@/lib/queries/stalled";
import { resendInvitation } from "@/lib/services/admin";
import { auditEvents } from "@/db/schema";
import { dropFests } from "@/lib/test-support";

let festId: string, techId: string, financeDeptId: string, coreId: string, expenseTypeId: string, lineItemId: string;
let member: Actor, techHod: Actor, finance: Actor, finance2: Actor, mgmt: Actor;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

/** Every request needs a receipt, so tests mint one the same way the API does. */
async function receipt(actor: Actor, sha?: string): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into attachments (fest_id, purpose, kind, storage_key, file_name, mime_type, size_bytes, sha256, uploaded_by)
    values (${festId}, 'RECEIPT', 'FILE', ${"k/" + Math.random()}, 'receipt.jpg', 'image/jpeg', 1024,
            ${sha ?? null}, ${actor.id})
    returning id`);
  return row.id;
}

const baseRequest = (overrides: Partial<Parameters<typeof createReimbursement>[1]> = {}) => ({
  lineItemId,
  expenseTypeId,
  description: "Sound cables for the main stage",
  transactionOn: "2026-11-27",
  amountPaise: R(5000),
  payeeName: "Tech Member",
  payeeUpiId: "tech.member@upi",
  attachmentIds: [] as string[],
  ...overrides,
});

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise, settings)
    values ('Flow Fest', 'flow-' || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', ${R(1000000)},
            '{"line_item_doc_threshold_paise": 1000000, "flag_thresholds": {"F6_count": 5, "F6_total_paise": 2500000}}'::jsonb)
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string, alloc: number) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${alloc}) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE", 0);
  coreId = await mkDept("Core", "core", "CORE", 0);
  techId = await mkDept("Tech", "tech", "BUDGET", R(100000));

  const mkUser = async (email: string, role: Actor["role"], deptId: string): Promise<Actor> => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE') returning id`)).id,
    festId, role, departmentId: deptId,
  });

  member = await mkUser("member@t.test", "MEMBER", techId);
  techHod = await mkUser("hod@t.test", "DEPT_HOD", techId);
  finance = await mkUser("fin@t.test", "FINANCE_HOD", financeDeptId);
  finance2 = await mkUser("fin2@t.test", "FINANCE_HOD", financeDeptId);
  mgmt = await mkUser("mg@t.test", "MANAGEMENT", coreId);

  expenseTypeId = (await one<{ id: string }>(sql`
    insert into expense_types (fest_id, name) values (${festId}, 'Equipment Rental') returning id`)).id;

  lineItemId = (await createLineItem(techHod, { departmentId: techId, name: "Sound", plannedPaise: R(60000) })).id;
  // Above the ₹10,000 document threshold, so it needs a quote before requests can attach (7.1).
  await db.execute(sql`
    insert into attachments (fest_id, entity_type, entity_id, purpose, kind, url, label, source_name, quoted_amount_paise, uploaded_by)
    values (${festId}, 'LINE_ITEM', ${lineItemId}, 'QUOTE', 'LINK', 'https://example.com/quote',
            'Quotation — ABC Sound', 'ABC Sound', ${R(58000)}, ${techHod.id})`);
});

afterAll(() => dropFests(db, "flow-"));

test("submit → endorse → approve → pay moves the money through the five numbers", async () => {
  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  expect(req.status).toBe("SUBMITTED");
  expect(req.humanId).toBe("RB-0001");

  // Pending, not yet committed or spent.
  let t = await lineItemTotals(lineItemId);
  expect([t!.pendingPaise, t!.committedPaise, t!.spentPaise]).toEqual([R(5000), 0, 0]);
  expect(t!.availablePaise).toBe(R(55000));

  await transitionReimbursement(techHod, req.id, "ENDORSE");
  t = await lineItemTotals(lineItemId);
  expect(t!.pendingPaise).toBe(R(5000));            // still pending — Finance has not decided

  await transitionReimbursement(finance, req.id, "APPROVE");
  t = await lineItemTotals(lineItemId);
  expect([t!.pendingPaise, t!.committedPaise, t!.spentPaise]).toEqual([0, R(5000), 0]);

  await transitionReimbursement(mgmt, req.id, "RECORD_PAYMENT", {
    payment_reference: "UTR123456789", paid_at: "2026-11-30",
  });
  t = await lineItemTotals(lineItemId);
  expect([t!.pendingPaise, t!.committedPaise, t!.spentPaise]).toEqual([0, 0, R(5000)]);
  expect(t!.availablePaise).toBe(R(55000));

  const dept = await departmentTotals(techId);
  expect(dept!.spentPaise).toBe(R(5000));
  expect(dept!.availablePaise).toBe(R(95000));
});

test("a Dept HOD's own request skips endorsement", async () => {
  const req = await createReimbursement(techHod, baseRequest({
    attachmentIds: [await receipt(techHod)], payeeUpiId: "hod@upi", submit: true,
  }));
  expect(req.status).toBe("HOD_ENDORSED");

  await expect(transitionReimbursement(techHod, req.id, "ENDORSE"))
    .rejects.toMatchObject({ code: "INVALID_TRANSITION" });
});

test("a Finance HOD's own request is approved by Management, not by Finance", async () => {
  const req = await createReimbursement(finance, baseRequest({
    attachmentIds: [await receipt(finance)], payeeUpiId: "fin@upi", submit: true,
  }));
  await transitionReimbursement(techHod, req.id, "ENDORSE");

  await expect(transitionReimbursement(finance, req.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(transitionReimbursement(finance2, req.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(transitionReimbursement(mgmt, req.id, "APPROVE")).resolves.toMatchObject({ status: "APPROVED" });
});

test("nobody pays their own request", async () => {
  const req = await createReimbursement(mgmt, baseRequest({
    attachmentIds: [await receipt(mgmt)], payeeUpiId: "mg@upi", submit: true,
  }));
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  await transitionReimbursement(finance, req.id, "APPROVE");

  await expect(transitionReimbursement(mgmt, req.id, "RECORD_PAYMENT", {
    payment_reference: "UTR1", paid_at: "2026-11-30",
  })).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("send back, edit, resubmit — a new version, the old one kept", async () => {
  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  await transitionReimbursement(techHod, req.id, "SEND_BACK", { reason: "receipt is unreadable" });

  const sent = await getReimbursementDetail(member, req.id);
  expect(sent.status).toBe("SENT_BACK");
  expect(sent.lastReason).toBe("receipt is unreadable");
  expect(sent.sendBackCount).toBe(1);

  const resubmitted = await transitionReimbursement(member, req.id, "RESUBMIT");
  expect(resubmitted.status).toBe("SUBMITTED");
  expect(resubmitted.version).toBe(2);
});

test("send back and decline both need a reason", async () => {
  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  await expect(transitionReimbursement(techHod, req.id, "SEND_BACK", {}))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(transitionReimbursement(techHod, req.id, "DECLINE", {}))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("hold and resolve round-trip through Finance", async () => {
  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  await transitionReimbursement(finance, req.id, "APPROVE");

  await transitionReimbursement(mgmt, req.id, "HOLD", { reason: "payee UPI bounced" });
  // ON_HOLD is still committed, not spent (6.2 bucket table).
  let t = await lineItemTotals(lineItemId);
  expect([t!.committedPaise, t!.spentPaise]).toEqual([R(5000), 0]);

  await expect(transitionReimbursement(mgmt, req.id, "RESOLVE_HOLD", { note: "fixed" }))
    .rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  await transitionReimbursement(finance, req.id, "RESOLVE_HOLD", { note: "payee gave a new UPI" });

  t = await lineItemTotals(lineItemId);
  expect(t!.committedPaise).toBe(R(5000));
});

test("a withdrawn request stops counting against the budget", async () => {
  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  expect((await lineItemTotals(lineItemId))!.pendingPaise).toBe(R(5000));

  await transitionReimbursement(member, req.id, "WITHDRAW");
  expect((await lineItemTotals(lineItemId))!.pendingPaise).toBe(0);
  expect((await lineItemTotals(lineItemId))!.availablePaise).toBe(R(60000));
});

test("a closed line item takes no new requests", async () => {
  const closed = await createLineItem(techHod, { departmentId: techId, name: "Spare", plannedPaise: R(1000) });
  await db.execute(sql`update line_items set status = 'CLOSED' where id = ${closed.id}`);

  await expect(createReimbursement(member, baseRequest({
    lineItemId: closed.id, attachmentIds: [await receipt(member)],
  }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("a request needs at least one receipt", async () => {
  await expect(createReimbursement(member, baseRequest({ attachmentIds: [] })))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("F5 fires when approval would take the line item below zero, but never blocks", async () => {
  const req = await createReimbursement(member, baseRequest({
    amountPaise: R(70000), attachmentIds: [await receipt(member)], submit: true,
  }));
  const detail = await getReimbursementDetail(finance, req.id);
  const f5 = detail.flags.find((f) => f.rule === "F5");
  expect(f5?.severity).toBe("HIGH");
  expect(f5?.explanation).toContain("below zero");

  // Advisory only — and approving over a High flag needs an acknowledgement note (8.3).
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  await expect(transitionReimbursement(finance, req.id, "APPROVE")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(transitionReimbursement(finance, req.id, "APPROVE", { approval_note: "HOD confirmed, reallocating" }))
    .resolves.toMatchObject({ status: "APPROVED" });
});

test("F1 catches the same receipt file submitted twice", async () => {
  const sha = "deadbeef".repeat(8);
  const a = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member, sha)], submit: true }));
  const b = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member, sha)], submit: true }));

  const detail = await getReimbursementDetail(finance, b.id);
  const f1 = detail.flags.find((f) => f.rule === "F1");
  expect(f1?.severity).toBe("HIGH");
  expect(f1?.explanation).toContain(a.humanId);
});

test("F4 flags a receipt dated outside the fest window", async () => {
  const req = await createReimbursement(member, baseRequest({
    transactionOn: "2026-06-01", attachmentIds: [await receipt(member)], submit: true,
  }));
  const detail = await getReimbursementDetail(finance, req.id);
  expect(detail.flags.find((f) => f.rule === "F4")?.severity).toBe("MEDIUM");
});

test("a flag closes itself when the condition goes away", async () => {
  const req = await createReimbursement(member, baseRequest({
    transactionOn: "2026-06-01", amountPaise: R(1000), attachmentIds: [await receipt(member)], submit: true,
  }));
  expect((await getReimbursementDetail(finance, req.id)).flags.some((f) => f.rule === "F4" && f.status === "OPEN")).toBe(true);

  await transitionReimbursement(member, req.id, "WITHDRAW");
  // Re-dating inside the window closes F4 on the next evaluation.
  await db.execute(sql`update reimbursement_requests set transaction_on = '2026-11-27', status = 'SUBMITTED' where id = ${req.id}`);
  const { evaluateReimbursementFlags } = await import("@/lib/flags");
  await db.transaction(async (tx) => { await evaluateReimbursementFlags(tx, req.id); });

  const after = await getReimbursementDetail(finance, req.id);
  expect(after.flags.filter((f) => f.rule === "F4" && f.status === "OPEN")).toHaveLength(0);
});

test("a Member cannot see or act on another member's request", async () => {
  const other = { ...member, id: (await one<{ id: string }>(sql`
    insert into users (fest_id, email, name, role, department_id, status)
    values (${festId}, 'other@t.test', 'Other', 'MEMBER', ${techId}, 'ACTIVE') returning id`)).id };

  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  await expect(getReimbursementDetail(other, req.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(transitionReimbursement(other, req.id, "WITHDRAW")).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("every transition leaves an audit event naming the actor and the reason", async () => {
  const req = await createReimbursement(member, baseRequest({ attachmentIds: [await receipt(member)], submit: true }));
  await transitionReimbursement(techHod, req.id, "SEND_BACK", { reason: "wrong line item" });

  const detail = await getReimbursementDetail(finance, req.id);
  const sendBack = detail.timeline.find((e) => e.action === "reimbursement.transition.SEND_BACK");
  expect(sendBack?.reason).toBe("wrong line item");
  expect(sendBack?.actor).toBe("hod@t.test");
  expect(sendBack?.before).toMatchObject({ status: "SUBMITTED" });
  expect(sendBack?.after).toMatchObject({ status: "SENT_BACK" });
});

/* ------------------------------------------------- a workflow with an empty seat */

/**
 * The failure that made a correct budget screen look broken.
 *
 * ₹2.00 sat in Committed with Spent at zero and nothing said why: the fest's only
 * Management account had never accepted its invitation, and 5.2 puts recording a
 * payment with Management and nobody else. The request was approved, correct, and
 * unpayable — and would have stayed that way all fest.
 *
 * The arithmetic is not the bug and loosening 5.2 is not the fix. Saying so is.
 */
test("an approved request with no active Management to pay it is reported as stalled", async () => {
  const req = await createReimbursement(member, baseRequest({
    amountPaise: R(1200), attachmentIds: [await receipt(member)], submit: true,
  }));
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  await transitionReimbursement(finance, req.id, "APPROVE");

  // Nothing is wrong with the numbers: it is committed, not spent, exactly as 6.2 says.
  const totals = await departmentTotals(techId);
  expect(totals?.committedPaise).toBe(R(1200));
  expect(totals?.spentPaise).toBe(0);

  // With Management active, this is an ordinary queue and not a stall.
  expect(await stalledStages(finance)).toHaveLength(0);

  // Take the seat away and it becomes one.
  await db.execute(sql`update users set status = 'INVITED' where id = ${mgmt.id}`);
  const stalled = await stalledStages(finance);
  expect(stalled).toHaveLength(1);
  expect(stalled[0].needs).toBe("MANAGEMENT");
  expect(stalled[0].count).toBe(1);
  expect(stalled[0].amountPaise).toBe(R(1200));
  // Invited-but-never-signed-in is a different sentence from never-appointed.
  expect(stalled[0].invitedNotActive).toBe(1);

  await db.execute(sql`update users set status = 'ACTIVE' where id = ${mgmt.id}`);
});

test("nothing waiting means nothing stalled, however empty the seats are", async () => {
  await db.execute(sql`update users set status = 'INVITED' where id = ${mgmt.id}`);
  expect(await stalledStages(finance)).toHaveLength(0);
  await db.execute(sql`update users set status = 'ACTIVE' where id = ${mgmt.id}`);
});

test("an invitation can be sent again without losing the account", async () => {
  // The unblock for the stall above. Re-inviting by deleting and re-creating would
  // lose the id every audit row already points at, so this keeps the row.
  await db.execute(sql`update users set status = 'INVITED' where id = ${mgmt.id}`);

  const result = await resendInvitation(finance, mgmt.id);
  expect(result.id).toBe(mgmt.id);

  const [row] = await db.select().from(auditEvents).where(and(
    eq(auditEvents.festId, festId),
    eq(auditEvents.entityId, mgmt.id),
    eq(auditEvents.action, "user.invite.resend"),
  ));
  // Recorded even if the mail provider then refuses: somebody tried, and that is
  // the fact you want when nobody can get in.
  expect(row.actorId).toBe(finance.id);

  await db.execute(sql`update users set status = 'ACTIVE' where id = ${mgmt.id}`);
});

test("a deactivated account is reactivated, not re-invited", async () => {
  await db.execute(sql`update users set status = 'DISABLED' where id = ${mgmt.id}`);
  await expect(resendInvitation(finance, mgmt.id)).rejects.toThrow(/deactivated/i);
  await db.execute(sql`update users set status = 'ACTIVE' where id = ${mgmt.id}`);
});

test("only somebody who manages users can send one", async () => {
  await expect(resendInvitation(member, mgmt.id)).rejects.toThrow(/not permitted/i);
});
