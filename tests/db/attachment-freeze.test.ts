/**
 * Evidence is fixed from the moment it is handed over (REVIEW_FINDINGS P0 #2).
 *
 * The property: the receipts a reviewer looked at are the receipts on the record
 * afterwards. Not "mostly" — the old rule froze removal at APPROVED and never froze
 * adding at all, which left two ways for the file set to move underneath somebody:
 * a claim sitting in SUBMITTED could have its receipt pulled while the HOD was
 * reading it, and a claim already PAID could still be handed another one.
 *
 * Both directions now ask the same question, and it is the one `can` already
 * answers: is this record still the submitter's to change? A correction after that
 * goes back through send-back and resubmit, which bumps `version` and tells the
 * reviewer the record moved.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import { completeUpload, createLink, removeAttachment } from "@/lib/services/attachments";
import { createReimbursement, transitionReimbursement } from "@/lib/services/reimbursements";
import { rupeesToPaise as R } from "@/lib/money";

const PREFIX = "froz-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, financeDeptId: string, coreId: string;
let expenseTypeId: string, lineItemId: string;
let member: SessionUser, techHod: SessionUser, finance: SessionUser, mgmt: SessionUser;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

/** A receipt row, as `presign` would leave it once the bytes had landed. */
async function receipt(actor: SessionUser, boundTo?: string): Promise<string> {
  return (await one<{ id: string }>(sql`
    insert into attachments (fest_id, entity_type, entity_id, purpose, kind, storage_key,
                             file_name, mime_type, size_bytes, uploaded_by)
    values (${festId}, ${boundTo ? "REIMBURSEMENT" : null}, ${boundTo ?? null},
            'RECEIPT', 'FILE', ${"k/" + Math.random()}, 'r.jpg', 'image/jpeg', 1024, ${actor.id})
    returning id`)).id;
}

const claim = async (actor: SessionUser) =>
  createReimbursement(actor, {
    lineItemId, expenseTypeId,
    description: "Cables and gaffer tape for the main stage",
    amountPaise: R(1200), transactionOn: "2026-11-20",
    payeeName: "Ravi", payeeUpiId: "ravi@upi",
    attachmentIds: [await receipt(actor)], submit: true,
  });

const addLink = (actor: SessionUser, entityId: string) =>
  createLink(actor, {
    entityType: "REIMBURSEMENT", entityId, purpose: "RECEIPT",
    url: "https://example.com/another-receipt.pdf", label: "A second receipt",
  });

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Freeze Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', ${R(1000000)})
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string, alloc = 0) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${alloc}) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET", R(100000));

  const mkUser = async (email: string, role: SessionUser["role"], deptId: string) => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE')
      returning id`)).id,
    festId, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
  } as SessionUser);

  member = await mkUser("m@f.test", "MEMBER", techId);
  techHod = await mkUser("h@f.test", "DEPT_HOD", techId);
  finance = await mkUser("f@f.test", "FINANCE_HOD", financeDeptId);
  mgmt = await mkUser("g@f.test", "MANAGEMENT", coreId);

  expenseTypeId = (await one<{ id: string }>(sql`
    insert into expense_types (fest_id, name) values (${festId}, 'Equipment') returning id`)).id;
  lineItemId = (await one<{ id: string }>(sql`
    insert into line_items (fest_id, department_id, name, planned_paise, created_by)
    values (${festId}, ${techId}, 'Sound', ${R(50000)}, ${finance.id}) returning id`)).id;
});

/* ------------------------------------------------------ while it is still yours */

test("a draft is yours to change, in both directions", async () => {
  const req = await createReimbursement(member, {
    lineItemId, expenseTypeId,
    description: "Cables and gaffer tape for the main stage",
    amountPaise: R(1200), transactionOn: "2026-11-20",
    payeeName: "Ravi", payeeUpiId: "ravi@upi",
    attachmentIds: [await receipt(member)], submit: false,
  });
  const extra = await addLink(member, req.id);
  await expect(removeAttachment(member, extra.id)).resolves.toBeTruthy();
});

test("sent back is yours again — which is the whole point of sending it back", async () => {
  const req = await claim(member);
  await transitionReimbursement(techHod, req.id, "SEND_BACK", { reason: "The receipt is unreadable" });

  const replacement = await addLink(member, req.id);
  expect(replacement.id).toBeTruthy();
});

/* ------------------------------------------- once somebody else is reading it */

/**
 * The window the old rule left open. SUBMITTED is not "not yet reviewed", it is
 * "on somebody's desk right now" — the single worst moment for the evidence to
 * change, and the one state the frozen list did not name.
 */
test("a submitted claim cannot have its receipt pulled", async () => {
  const req = await claim(member);
  const [bound] = await db.select().from(attachments).where(eq(attachments.entityId, req.id));

  await expect(removeAttachment(member, bound.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  // Still there, still not removed.
  const [after] = await db.select().from(attachments).where(eq(attachments.id, bound.id));
  expect(after.removedAt).toBeNull();
});

test("a submitted claim cannot quietly gain another one", async () => {
  const req = await claim(member);
  await expect(addLink(member, req.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("nor can an endorsed one, in either direction", async () => {
  const req = await claim(member);
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  const [bound] = await db.select().from(attachments).where(eq(attachments.entityId, req.id));

  await expect(addLink(member, req.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(removeAttachment(member, bound.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

/**
 * The half that was never frozen at all. Removal stopped at APPROVED; adding never
 * stopped, so the file set behind a payment was never actually settled.
 */
test("a paid claim cannot gain evidence after the fact", async () => {
  const req = await claim(member);
  await transitionReimbursement(techHod, req.id, "ENDORSE");
  await transitionReimbursement(finance, req.id, "APPROVE");
  await transitionReimbursement(mgmt, req.id, "RECORD_PAYMENT", {
    payment_reference: "UTR-1", paid_at: "2026-11-25",
  });

  await expect(addLink(member, req.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("the refusal points at the flow that exists for this", async () => {
  const req = await claim(member);
  await expect(addLink(member, req.id)).rejects.toThrow(/sent back/i);
});

/* ------------------------------------------------------- the gap after presign */

/**
 * `presign` answers the permission question before a bearer URL exists, which is
 * right — and leaves that answer minutes old by the time the bytes arrive. A claim
 * submitted in between would otherwise bind a receipt nobody reviewed.
 *
 * Simulated by binding the row first and then submitting, which is the same
 * ordering from the record's point of view.
 */
test("an upload started before submission does not bind after it", async () => {
  const req = await createReimbursement(member, {
    lineItemId, expenseTypeId,
    description: "Cables and gaffer tape for the main stage",
    amountPaise: R(1200), transactionOn: "2026-11-20",
    payeeName: "Ravi", payeeUpiId: "ravi@upi",
    attachmentIds: [await receipt(member)], submit: false,
  });
  const inFlight = await receipt(member, req.id);
  await transitionReimbursement(member, req.id, "SUBMIT");

  /*
   * Asserted on the *message*, not just the code. Without the check this call still
   * fails — at "no file was uploaded to that URL", because the fixture never put
   * bytes in a bucket — and a test that accepted any VALIDATION_ERROR would have
   * passed against the bug it exists to catch.
   */
  await expect(completeUpload(member, inFlight)).rejects.toThrow(/sent back/i);
});

/* ------------------------------------------------------------------ unchanged */

test("somebody else's file is still not yours to remove", async () => {
  const req = await claim(member);
  const [bound] = await db.select().from(attachments).where(eq(attachments.entityId, req.id));
  await expect(removeAttachment(techHod, bound.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("a reviewer cannot add evidence to somebody's claim either", async () => {
  const req = await claim(member);
  // Not the submitter, so this is the "not yours" refusal rather than "too late".
  await expect(addLink(finance, req.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
});
