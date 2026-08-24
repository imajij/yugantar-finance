/**
 * The three hard blocks (PRD 4.7, 7.5, 21.4) exercised against a real database:
 *   1. Σ line items ≤ department allocation
 *   2. a line item never shrinks below its own committed + spent
 *   3. an allocation never drops below its committed + spent, and the reserve never goes negative
 * Everything else about over-budget spend is a flag, never a block.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ApiError } from "@/lib/api";
import type { Actor } from "@/lib/authz";
import { createLineItem, updateLineItem, transitionLineItem } from "@/lib/services/line-items";
import { transferBudget, setTotalBudget } from "@/lib/services/budget";
import { departmentTotals } from "@/lib/queries/budget";
import { rupeesToPaise as R } from "@/lib/money";
import { dropFests } from "@/lib/test-support";

let festId: string, techId: string, logisticsId: string, financeDeptId: string, expenseTypeId: string;
let finance: Actor, techHod: Actor, member: Actor;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

beforeEach(async () => {
  const fest = await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Guard Fest', 'guard-' || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', ${R(1000000)})
    returning id`);
  festId = fest.id;

  const mk = async (name: string, slug: string, kind: string, alloc: number) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${alloc}) returning id`)).id;

  financeDeptId = await mk("Finance", "finance", "FINANCE", 0);
  techId = await mk("Tech", "tech", "BUDGET", R(400000));
  logisticsId = await mk("Logistics", "logistics", "BUDGET", R(200000));
  // Reserve = 10,00,000 − 6,00,000 = 4,00,000

  const mkUser = async (email: string, role: string, deptId: string) =>
    (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE') returning id`)).id;

  finance = { id: await mkUser("f@t.test", "FINANCE_HOD", financeDeptId), festId, role: "FINANCE_HOD", departmentId: financeDeptId };
  techHod = { id: await mkUser("t@t.test", "DEPT_HOD", techId), festId, role: "DEPT_HOD", departmentId: techId };
  member = { id: await mkUser("m@t.test", "MEMBER", techId), festId, role: "MEMBER", departmentId: techId };

  expenseTypeId = (await one<{ id: string }>(sql`
    insert into expense_types (fest_id, name) values (${festId}, 'Equipment Rental') returning id`)).id;
});

afterAll(() => dropFests(db, "guard-"));

test("line items may fill the allocation exactly, but not exceed it", async () => {
  await createLineItem(techHod, { departmentId: techId, name: "Sound", plannedPaise: R(250000) });
  await createLineItem(techHod, { departmentId: techId, name: "Lights", plannedPaise: R(150000) });

  const totals = await departmentTotals(techId);
  expect(totals!.plannedPaise).toBe(R(400000));

  await expect(
    createLineItem(techHod, { departmentId: techId, name: "Cables", plannedPaise: R(1) }),
  ).rejects.toMatchObject({ code: "OVER_ALLOCATION" });
});

test("a Member cannot create a line item, and an HOD cannot touch another department", async () => {
  await expect(
    createLineItem(member, { departmentId: techId, name: "Sneaky", plannedPaise: R(1000) }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });

  await expect(
    createLineItem(techHod, { departmentId: logisticsId, name: "Not mine", plannedPaise: R(1000) }),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });

  // Finance HOD may create in any department (5.1).
  await expect(
    createLineItem(finance, { departmentId: logisticsId, name: "Transport", plannedPaise: R(50000) }),
  ).resolves.toMatchObject({ name: "Transport" });
});

test("a line item cannot shrink below money already committed or spent", async () => {
  const item = await createLineItem(techHod, { departmentId: techId, name: "Sound", plannedPaise: R(200000) });

  // An approved request commits ₹1,50,000 against it.
  await db.execute(sql`
    insert into reimbursement_requests
      (fest_id, human_id, department_id, line_item_id, expense_type_id, submitter_id,
       description, transaction_on, amount_paise, payee_name, payee_upi_id, status)
    values (${festId}, 'RB-0001', ${techId}, ${item.id}, ${expenseTypeId}, ${member.id},
            'committed spend', '2026-11-27', ${R(150000)}, 'Payee', 'payee@upi', 'APPROVED')`);

  await expect(
    updateLineItem(techHod, item.id, { plannedPaise: R(100000) }),
  ).rejects.toMatchObject({ code: "OVER_ALLOCATION" });

  await expect(updateLineItem(techHod, item.id, { plannedPaise: R(150000) }))
    .resolves.toMatchObject({ plannedPaise: R(150000) });
});

test("closing a line item releases its unspent balance to the department buffer", async () => {
  const item = await createLineItem(techHod, { departmentId: techId, name: "Spare", plannedPaise: R(100000) });
  const before = await departmentTotals(techId);
  expect(before!.plannedPaise).toBe(R(100000));

  await transitionLineItem(techHod, item.id, "CLOSE", { reason: "no more spend expected" });

  // Planned still counts a closed item; Available is unchanged because nothing was spent.
  const after = await departmentTotals(techId);
  expect(after!.availablePaise).toBe(R(400000));
  expect(await closeReason(item.id)).toBe("no more spend expected");
});

test("closing needs a reason, and only Finance may mark an item reviewed", async () => {
  const item = await createLineItem(techHod, { departmentId: techId, name: "Spare", plannedPaise: R(1000) });
  await expect(transitionLineItem(techHod, item.id, "CLOSE", {}))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  await expect(transitionLineItem(techHod, item.id, "MARK_REVIEWED", {}))
    .rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(transitionLineItem(finance, item.id, "MARK_REVIEWED", {}))
    .resolves.toMatchObject({ reviewedBy: finance.id });
});

test("a transfer moves allocation and records history", async () => {
  await transferBudget(finance, {
    fromDepartmentId: techId, toDepartmentId: logisticsId, amountPaise: R(100000), reason: "logistics needs more",
  });
  expect((await departmentTotals(techId))!.allocatedPaise).toBe(R(300000));
  expect((await departmentTotals(logisticsId))!.allocatedPaise).toBe(R(300000));

  const rows = await db.execute(sql`select * from budget_transfers where fest_id = ${festId}`);
  expect((rows as unknown as unknown[]).length).toBe(1);
});

test("a department cannot be drained below its committed + spent", async () => {
  const item = await createLineItem(techHod, { departmentId: techId, name: "Sound", plannedPaise: R(300000) });
  await db.execute(sql`
    insert into reimbursement_requests
      (fest_id, human_id, department_id, line_item_id, expense_type_id, submitter_id,
       description, transaction_on, amount_paise, payee_name, payee_upi_id, status)
    values (${festId}, 'RB-0002', ${techId}, ${item.id}, ${expenseTypeId}, ${member.id},
            'already paid out', '2026-11-27', ${R(250000)}, 'Payee', 'payee@upi', 'PAID')`);

  await expect(transferBudget(finance, {
    fromDepartmentId: techId, toDepartmentId: null, amountPaise: R(200000), reason: "claw back",
  })).rejects.toMatchObject({ code: "OVER_ALLOCATION" });

  // Down to exactly committed + spent is fine.
  await expect(transferBudget(finance, {
    fromDepartmentId: techId, toDepartmentId: null, amountPaise: R(150000), reason: "claw back the rest",
  })).resolves.toBeTruthy();
  expect((await departmentTotals(techId))!.allocatedPaise).toBe(R(250000));
});

test("the reserve cannot go negative — the one hard block at fest level", async () => {
  // Reserve is ₹4,00,000.
  await expect(transferBudget(finance, {
    fromDepartmentId: null, toDepartmentId: techId, amountPaise: R(500000), reason: "too much",
  })).rejects.toMatchObject({ code: "OVER_ALLOCATION" });

  await expect(transferBudget(finance, {
    fromDepartmentId: null, toDepartmentId: techId, amountPaise: R(400000), reason: "all of it",
  })).resolves.toBeTruthy();
});

test("only Finance transfers budget, and the fest total cannot drop below allocations", async () => {
  await expect(transferBudget(techHod, {
    fromDepartmentId: logisticsId, toDepartmentId: techId, amountPaise: R(1000), reason: "mine now",
  })).rejects.toMatchObject({ code: "FORBIDDEN" });

  await expect(setTotalBudget(finance, R(500000), "cut")).rejects.toMatchObject({ code: "OVER_ALLOCATION" });
  await expect(setTotalBudget(finance, R(600000), "cut to the bone")).resolves.toBeTruthy();
});

test("every write leaves an audit event with a before and after", async () => {
  const item = await createLineItem(techHod, { departmentId: techId, name: "Sound", plannedPaise: R(100000) });
  await updateLineItem(techHod, item.id, { plannedPaise: R(120000), reason: "quote came in higher" });

  const events = (await db.execute(sql`
    select action, before, after, reason from audit_events
    where entity_type = 'LINE_ITEM' and entity_id = ${item.id} order by created_at
  `)) as unknown as { action: string; before: unknown; after: Record<string, unknown>; reason: string | null }[];

  expect(events.map((e) => e.action)).toEqual(["line_item.create", "line_item.update"]);
  expect(events[1].before).toMatchObject({ plannedPaise: R(100000) });
  expect(events[1].after).toMatchObject({ plannedPaise: R(120000) });
  expect(events[1].reason).toBe("quote came in higher");
});

test("errors carry the 20.1 codes, not raw database errors", async () => {
  const err = await createLineItem(techHod, { departmentId: techId, name: "Too big", plannedPaise: R(999999) })
    .catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.code).toBe("OVER_ALLOCATION");
  expect(err.details).toMatchObject({ allocated_paise: R(400000) });
});

async function closeReason(id: string): Promise<string | null> {
  const r = await one<{ close_reason: string | null }>(sql`select close_reason from line_items where id = ${id}`);
  return r.close_reason;
}
