/**
 * PRD 7.3 — a vendor purchase end to end, and what it does to the five numbers.
 * The money model this pins down: approving commits the WHOLE contract, each paid
 * milestone converts its slice to spent, and reducing the balance gives the rest back.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { Actor } from "@/lib/authz";
import { rupeesToPaise as R } from "@/lib/money";
import { createLineItem } from "@/lib/services/line-items";
import {
  createVendor, createVendorRequest, deleteVendor, getVendorRequestDetail,
  transitionVendorRequest, updateVendor, vendorExposure,
} from "@/lib/services/vendors";
import { lineItemTotals } from "@/lib/queries/budget";
import { dropFests } from "@/lib/test-support";

afterAll(() => dropFests(db, "vend-"));

let festId: string, techId: string, financeDeptId: string, coreId: string;
let lineItemId: string, vendorId: string;
let member: Actor, techHod: Actor, finance: Actor, mgmt: Actor;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

async function attachment(actor: Actor, purpose: string, quoted?: number): Promise<string> {
  const row = await one<{ id: string }>(sql`
    insert into attachments (fest_id, purpose, kind, storage_key, file_name, mime_type, size_bytes,
                             quoted_amount_paise, uploaded_by)
    values (${festId}, ${sql.raw(`'${purpose}'::attachment_purpose`)}, 'FILE', ${"k/" + Math.random()},
            'doc.pdf', 'application/pdf', 2048, ${quoted ?? null}, ${actor.id})
    returning id`);
  return row.id;
}

const request = (overrides: Partial<Parameters<typeof createVendorRequest>[1]> = {}) => ({
  vendorId,
  lineItemId,
  description: "Line array speakers and monitors for the main stage",
  totalValuePaise: R(40000),
  milestones: [
    { kind: "ADVANCE" as const, plannedPaise: R(16000) },
    { kind: "BALANCE" as const, plannedPaise: R(24000) },
  ],
  expectedDeliveryOn: "2026-11-26",
  ...overrides,
});

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end,
                       total_budget_paise, settings)
    values ('Vendor Fest', 'vend-' || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14',
            ${R(1000000)}, '{"flag_thresholds": {"F8_pct": 50}}'::jsonb)
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

  member = await mkUser("member@v.test", "MEMBER", techId);
  techHod = await mkUser("hod@v.test", "DEPT_HOD", techId);
  finance = await mkUser("fin@v.test", "FINANCE_HOD", financeDeptId);
  mgmt = await mkUser("mg@v.test", "MANAGEMENT", coreId);

  lineItemId = (await createLineItem(techHod, { departmentId: techId, name: "Sound", plannedPaise: R(60000) })).id;
  vendorId = (await createVendor(finance, {
    name: "Bengaluru Sound Co", contactName: "Ravi", phone: "9800000000",
    bankAccountNumber: "123456789012", bankIfsc: "HDFC0001234",
  })).id;
});

test("approve commits the whole contract; each payment converts its slice to spent", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));

  // Submitted is not yet a commitment.
  expect((await lineItemTotals(lineItemId))!.committedPaise).toBe(0);

  await transitionVendorRequest(finance, req.id, "APPROVE");
  let t = (await lineItemTotals(lineItemId))!;
  expect(t.committedPaise).toBe(R(40000));
  expect(t.spentPaise).toBe(0);
  expect(t.availablePaise).toBe(R(20000));

  const detail = await getVendorRequestDetail(finance, req.id);
  const advance = detail.milestones.find((m) => m.kind === "ADVANCE")!;

  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000),
    paid_at: "2026-11-20", payment_reference: "UTR-ADV-1",
  });
  t = (await lineItemTotals(lineItemId))!;
  expect(t.spentPaise).toBe(R(16000));
  expect(t.committedPaise).toBe(R(24000));
  expect(t.availablePaise).toBe(R(20000));         // unchanged: committed simply became spent

  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(40000)),
    invoice_total_paise: R(40000),
  });
  await transitionVendorRequest(finance, req.id, "RELEASE_BALANCE");

  const balance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "BALANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_BALANCE", {
    milestone_id: balance.id, paid_paise: R(24000),
    paid_at: "2026-11-30", payment_reference: "UTR-BAL-1",
  });

  t = (await lineItemTotals(lineItemId))!;
  expect(t.spentPaise).toBe(R(40000));
  expect(t.committedPaise).toBe(0);
  expect(t.availablePaise).toBe(R(20000));
  expect((await getVendorRequestDetail(finance, req.id)).status).toBe("CLOSED");
});

test("releasing a smaller balance hands the difference back to the line item", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");

  const advance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "ADVANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV-2",
  });
  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(30000)),
    invoice_total_paise: R(30000),
  });

  // They delivered less than contracted: release ₹30,000 total, not ₹40,000.
  await transitionVendorRequest(finance, req.id, "RELEASE_BALANCE", {
    approved_value_paise: R(30000), reason: "two monitors short",
  });

  const t = (await lineItemTotals(lineItemId))!;
  expect(t.spentPaise).toBe(R(16000));
  expect(t.committedPaise).toBe(R(14000));         // ₹30,000 approved − ₹16,000 already paid
  expect(t.availablePaise).toBe(R(30000));         // ₹10,000 came back
});

test("the balance cannot be released for more than was approved, or below what is paid", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");

  const advance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "ADVANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV-3",
  });
  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(40000)),
    invoice_total_paise: R(40000),
  });

  await expect(transitionVendorRequest(finance, req.id, "RELEASE_BALANCE", {
    approved_value_paise: R(50000), reason: "they asked for more",
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

  await expect(transitionVendorRequest(finance, req.id, "RELEASE_BALANCE", {
    approved_value_paise: R(10000), reason: "below the advance already paid",
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("milestones must add up to the total", async () => {
  await expect(createVendorRequest(techHod, request({
    milestones: [
      { kind: "ADVANCE", plannedPaise: R(16000) },
      { kind: "BALANCE", plannedPaise: R(20000) },   // ₹4,000 short
    ],
  }))).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("F8 fires when the advance is more than half the contract", async () => {
  const heavy = await createVendorRequest(techHod, request({
    totalValuePaise: R(40000),
    milestones: [
      { kind: "ADVANCE", plannedPaise: R(30000) },   // 75%
      { kind: "BALANCE", plannedPaise: R(10000) },
    ],
    submit: true,
  }));
  const flags = (await getVendorRequestDetail(finance, heavy.id)).flags;
  expect(flags.some((f) => f.rule === "F8" && f.status === "OPEN")).toBe(true);
});

test("F9 fires when the invoice does not match what was approved", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");

  const advance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "ADVANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV-4",
  });
  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(47000)),
    invoice_total_paise: R(47000),                  // ₹7,000 over the approved value
  });

  const flags = (await getVendorRequestDetail(finance, req.id)).flags;
  expect(flags.some((f) => f.rule === "F9" && f.status === "OPEN")).toBe(true);
});

test("a member cannot approve, and the raiser cannot approve their own request", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await expect(transitionVendorRequest(member, req.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });

  const own = await createVendorRequest(finance, request({ submit: true }));
  await expect(transitionVendorRequest(finance, own.id, "APPROVE")).rejects.toMatchObject({ code: "FORBIDDEN" });
});

test("cancelling after an advance expects that money back", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");

  const advance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "ADVANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV-5",
  });

  const cancelled = await transitionVendorRequest(finance, req.id, "CANCEL", { reason: "vendor pulled out" });
  expect(cancelled.refundExpectedPaise).toBe(R(16000));

  await transitionVendorRequest(mgmt, req.id, "RECORD_REFUND", {
    amount_paise: R(16000), received_at: "2026-12-01", reference: "UTR-REF-1",
  });
  const after = await getVendorRequestDetail(finance, req.id);
  expect(after.refundReceivedPaise).toBe(R(16000));

  // Overshooting the refund is refused.
  await expect(transitionVendorRequest(mgmt, req.id, "RECORD_REFUND", {
    amount_paise: R(1000), received_at: "2026-12-02",
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("exposure adds up, and bank details are masked below Finance", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");

  const [e] = await vendorExposure(festId, vendorId);
  expect(e.contractedPaise).toBe(R(40000));
  expect(e.paidPaise).toBe(0);
  expect(e.outstandingPaise).toBe(R(40000));

  // A department HOD sees the request but not the vendor's account number (20.7).
  const asHod = await getVendorRequestDetail(techHod, req.id);
  expect(asHod.vendor.bankAccountNumber).toBe("••••9012");
  const asFinance = await getVendorRequestDetail(finance, req.id);
  expect(asFinance.vendor.bankAccountNumber).toBe("123456789012");
});

/* --------------------------------------------------- editing and retiring (20.7) */

test("an HOD can correct a vendor's details; retiring one is narrower", async () => {
  // Editing is `vendor.manage` — Finance and any HOD, because they are the people
  // who type the number wrong in the first place.
  await expect(updateVendor(techHod, vendorId, { phone: "9000000000" })).resolves.toBeTruthy();

  // Retiring is `vendor.delete`: a vendor carries the payment trail for every
  // request raised against it, so taking one out of circulation is Finance's call.
  await expect(deleteVendor(techHod, vendorId, "no longer used"))
    .rejects.toThrow(/not permitted/i);
});

test("a vendor with a live obligation cannot be retired, and the refusal names it", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");

  await expect(deleteVendor(finance, vendorId, "tidying up"))
    .rejects.toMatchObject({
      code: "CONFLICT",
      details: { requests: [{ human_id: req.humanId, status: "APPROVED" }] },
    });
});

test("retiring is soft, so everything already raised against the vendor still reads", async () => {
  // History is no obstacle to retiring a vendor — only a live obligation is.
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "DECLINE", { reason: "Went elsewhere" });

  await deleteVendor(finance, vendorId, "Not using them again");

  // The vendor is gone from the list…
  const [{ n }] = (await db.execute(sql`
    select count(*)::int as n from vendors where id = ${vendorId} and deleted_at is null
  `)) as unknown as { n: number }[];
  expect(Number(n)).toBe(0);

  // …and the request that named them is untouched, which is the point of soft delete.
  const detail = await getVendorRequestDetail(finance, req.id);
  expect(detail.vendor.name).toBeTruthy();
});

/* ------------------------------------------- a payment settles its own milestone */

/**
 * Approved, advance paid, balance released — the state a request is in when the
 * only thing left is to pay the balance and close it.
 */
async function readyForBalance() {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");
  const advance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "ADVANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV",
  });
  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(40000)),
    invoice_total_paise: R(40000),
  });
  await transitionVendorRequest(finance, req.id, "RELEASE_BALANCE");
  const balance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "BALANCE")!;
  return { req, balance };
}

/**
 * The one that closed a ₹24,000 balance with a one-paisa transfer.
 *
 * CLOSED leaves Committed entirely (0001_views.sql), so the request settled, the
 * ₹23,999.99 nobody had paid stopped being committed, and it came back as
 * Available — money the department could then spend twice, with nothing anywhere
 * recording that the vendor was still owed it.
 */
test("a token payment cannot settle a milestone", async () => {
  const { req, balance } = await readyForBalance();

  await expect(transitionVendorRequest(mgmt, req.id, "RECORD_BALANCE", {
    milestone_id: balance.id, paid_paise: 1, paid_at: "2026-11-28", payment_reference: "UTR-BAL",
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

  // Untouched: still open, still owed, still committed.
  const after = await getVendorRequestDetail(finance, req.id);
  expect(after.status).toBe("BALANCE_APPROVED");
  expect(after.milestones.find((m) => m.kind === "BALANCE")!.paidPaise).toBeNull();
  expect((await lineItemTotals(lineItemId))!.committedPaise).toBe(R(24000));
});

test("a payment cannot exceed its milestone either", async () => {
  const { req, balance } = await readyForBalance();

  await expect(transitionVendorRequest(mgmt, req.id, "RECORD_BALANCE", {
    milestone_id: balance.id, paid_paise: R(30000), paid_at: "2026-11-28", payment_reference: "UTR-BAL",
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

/**
 * Paying less is legitimate — it just is not a payment. 7.3 routes it through the
 * release, where it needs a reason and the difference visibly goes back.
 */
test("paying less than planned goes through the release, and still closes", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");
  const advance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "ADVANCE")!;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: advance.id, paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV",
  });
  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(30000)),
    invoice_total_paise: R(30000),
  });
  // Two speakers short: approved value down to ₹30,000, so the balance is ₹14,000.
  await transitionVendorRequest(finance, req.id, "RELEASE_BALANCE", {
    approved_value_paise: R(30000), reason: "Two monitors were not delivered",
  });

  const balance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "BALANCE")!;
  expect(balance.plannedPaise).toBe(R(14000));

  const closed = await transitionVendorRequest(mgmt, req.id, "RECORD_BALANCE", {
    milestone_id: balance.id, paid_paise: R(14000), paid_at: "2026-11-28", payment_reference: "UTR-BAL",
  });
  expect(closed.status).toBe("CLOSED");

  // ₹30,000 spent, nothing committed, and the ₹10,000 back where it came from.
  const t = (await lineItemTotals(lineItemId))!;
  expect(t.spentPaise).toBe(R(30000));
  expect(t.committedPaise).toBe(0);
});

test("a payment has to be for the milestone the action names", async () => {
  const req = await createVendorRequest(techHod, request({ submit: true }));
  await transitionVendorRequest(finance, req.id, "APPROVE");
  const balance = (await getVendorRequestDetail(finance, req.id)).milestones.find((m) => m.kind === "BALANCE")!;

  // Otherwise this marks the balance paid and parks the request in ADVANCE_PAID:
  // half-settled by its status, with nothing left to pay.
  await expect(transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: balance.id, paid_paise: R(24000), paid_at: "2026-11-20", payment_reference: "UTR-X",
  })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

/**
 * The MVP makes two milestones; the schema allows more. A request with a third
 * still unpaid must not close, because CLOSED takes the whole thing out of
 * Committed and whatever is still owed would simply stop existing.
 */
test("the balance payment does not close a request that still owes something", async () => {
  const req = await createVendorRequest(techHod, request({
    submit: true,
    milestones: [
      { kind: "ADVANCE" as const, plannedPaise: R(16000) },
      { kind: "BALANCE" as const, plannedPaise: R(14000) },
      { kind: "OTHER" as const, plannedPaise: R(10000) },
    ],
  }));
  await transitionVendorRequest(finance, req.id, "APPROVE");
  const ms = (await getVendorRequestDetail(finance, req.id)).milestones;
  await transitionVendorRequest(mgmt, req.id, "RECORD_ADVANCE", {
    milestone_id: ms.find((m) => m.kind === "ADVANCE")!.id,
    paid_paise: R(16000), paid_at: "2026-11-20", payment_reference: "UTR-ADV",
  });
  await transitionVendorRequest(techHod, req.id, "CONFIRM_DELIVERY", {
    delivered_at: "2026-11-26",
    invoice_attachment_id: await attachment(techHod, "INVOICE", R(40000)),
    invoice_total_paise: R(40000),
  });
  await transitionVendorRequest(finance, req.id, "RELEASE_BALANCE");

  const after = (await getVendorRequestDetail(finance, req.id)).milestones;
  const paid = await transitionVendorRequest(mgmt, req.id, "RECORD_BALANCE", {
    milestone_id: after.find((m) => m.kind === "BALANCE")!.id,
    paid_paise: after.find((m) => m.kind === "BALANCE")!.plannedPaise,
    paid_at: "2026-11-28", payment_reference: "UTR-BAL",
  });

  expect(paid.status).toBe("BALANCE_APPROVED");
  // The third milestone is still owed, and still says so.
  expect((await lineItemTotals(lineItemId))!.committedPaise).toBe(R(10000));
});
