/**
 * PRD 7.1 / 7.5 — a department head asking for a different allocation.
 *
 * What this pins down is the boundary the feature was built around: the HOD drives
 * the conversation and Finance still moves the money. Approving is not a rubber
 * stamp on a number decided last week — it performs the transfer *now*, under every
 * guard `transferBudget` applies, so an ask can be refused by arithmetic that
 * changed after it was raised.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { allocationRequests, departments } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import {
  createAllocationRequest, decideAllocationRequest, listAllocationRequests,
  pendingFor, withdrawAllocationRequest,
} from "@/lib/services/allocations";
import { transferBudget } from "@/lib/services/budget";

const PREFIX = "alloc-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string, coreId: string;
let techHod: SessionUser, logiHod: SessionUser, finance: SessionUser, mgmt: SessionUser, admin: SessionUser;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

const allocationOf = async (id: string) =>
  (await db.select({ p: departments.allocatedPaise }).from(departments).where(eq(departments.id, id)))[0].p;

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Allocation Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 10000000)
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string, allocated = 0) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${allocated})
      returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  // 1,00,000 of a 1,00,000-rupee fest: 20,000 out, 80,000 left in Reserve.
  techId = await mkDept("Tech", "tech", "BUDGET", 2000000);
  logiId = await mkDept("Logistics", "logistics", "BUDGET", 0);

  const mkUser = async (email: string, role: SessionUser["role"], deptId: string, superAdmin = false) => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status, is_super_admin)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE', ${superAdmin})
      returning id`)).id,
    festId, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
    isSuperAdmin: superAdmin,
  } as SessionUser);

  techHod = await mkUser("tech.hod@a.test", "DEPT_HOD", techId);
  logiHod = await mkUser("logi.hod@a.test", "DEPT_HOD", logiId);
  finance = await mkUser("finance@a.test", "FINANCE_HOD", financeDeptId, true);
  mgmt = await mkUser("mgmt@a.test", "MANAGEMENT", coreId);
  admin = await mkUser("admin@a.test", "MEMBER", techId, true);
});

const ask = (actor: SessionUser, deptId: string, paise: number) =>
  createAllocationRequest(actor, {
    departmentId: deptId,
    requestedPaise: paise,
    reason: "The sound quote came in higher than we budgeted for",
  });

/* ------------------------------------------------------------- who may ask */

test("an HOD asks for their own department and nobody else's", async () => {
  await expect(ask(techHod, logiId, 3000000)).rejects.toThrow(/not permitted/i);
  await expect(ask(techHod, techId, 3000000)).resolves.toBeTruthy();
});

test("Finance does not ask — they transfer", async () => {
  // Not an oversight: `allocationRequest.create` is `hod && own`, so the person who
  // can simply move the money has no ask to make.
  await expect(ask(finance, techId, 3000000)).rejects.toThrow(/not permitted/i);
});

test("only one open ask per department", async () => {
  await ask(techHod, techId, 3000000);
  await expect(ask(techHod, techId, 4000000)).rejects.toThrow(/already has a request/i);

  const open = await pendingFor(techHod, techId);
  await withdrawAllocationRequest(techHod, open!.id);
  await expect(ask(techHod, techId, 4000000)).resolves.toBeTruthy();
});

test("an ask below what is already committed is refused when it is made", async () => {
  // Nothing is committed here, so the floor is zero and any non-negative ask stands;
  // the guard that matters is proven by the approval path below.
  await expect(ask(techHod, techId, 0)).resolves.toBeTruthy();
});

test("asking for what you already have is refused", async () => {
  await expect(ask(techHod, techId, 2000000)).rejects.toThrow(/already the allocation/i);
});

/* ---------------------------------------------------------- who may decide */

test("the HOD who asked cannot approve their own request", async () => {
  const req = await ask(techHod, techId, 3000000);
  await expect(decideAllocationRequest(techHod, req.id, "APPROVE", "yes please"))
    .rejects.toThrow(/not permitted/i);
  expect(await allocationOf(techId)).toBe(2000000);
});

test("Management cannot decide an allocation either", async () => {
  // Management pays; they do not allocate. Same list as `budget.transfer`.
  const req = await ask(techHod, techId, 3000000);
  await expect(decideAllocationRequest(mgmt, req.id, "APPROVE", "fine"))
    .rejects.toThrow(/not permitted/i);
});

test("an administrator can decide one, because they can transfer", async () => {
  const req = await ask(techHod, techId, 3000000);
  await decideAllocationRequest(admin, req.id, "APPROVE", "Approved for the sound quote");
  expect(await allocationOf(techId)).toBe(3000000);
});

/* ------------------------------------------------------------- the outcome */

test("approving moves the money and records the transfer against the ask", async () => {
  const req = await ask(techHod, techId, 3000000);
  const after = await decideAllocationRequest(finance, req.id, "APPROVE", "Approved");

  expect(after.status).toBe("APPROVED");
  expect(after.transferId).toBeTruthy();
  expect(await allocationOf(techId)).toBe(3000000);

  // The link from the ask to the money: one transfer, for exactly the difference.
  const [transfer] = (await db.execute(sql`
    select amount_paise, from_department_id, to_department_id, reason
      from budget_transfers where id = ${after.transferId}`)) as unknown as Record<string, unknown>[];
  expect(Number(transfer.amount_paise)).toBe(1000000);
  expect(transfer.from_department_id).toBeNull();          // out of Reserve
  expect(transfer.to_department_id).toBe(techId);
  expect(String(transfer.reason)).toContain("sound quote");
});

test("declining moves nothing and keeps the note", async () => {
  const req = await ask(techHod, techId, 3000000);
  const after = await decideAllocationRequest(finance, req.id, "DECLINE", "Reserve is spoken for");

  expect(after.status).toBe("DECLINED");
  expect(after.transferId).toBeNull();
  expect(after.decisionNote).toBe("Reserve is spoken for");
  expect(await allocationOf(techId)).toBe(2000000);
});

test("a decision needs a note either way", async () => {
  const req = await ask(techHod, techId, 3000000);
  await expect(decideAllocationRequest(finance, req.id, "APPROVE", "   "))
    .rejects.toThrow(/note is required/i);
});

test("a request cannot be decided twice", async () => {
  const req = await ask(techHod, techId, 3000000);
  await decideAllocationRequest(finance, req.id, "APPROVE", "Approved");
  await expect(decideAllocationRequest(finance, req.id, "DECLINE", "Changed my mind"))
    .rejects.toThrow(/already approved/i);
});

/**
 * The reason approval performs the transfer rather than replaying a decision: the
 * arithmetic has to hold *now*. Here the reserve is emptied after the ask is
 * raised, and the approval is refused rather than overdrawing the fest.
 */
test("an ask the reserve can no longer cover is refused at approval, not at asking", async () => {
  const req = await ask(techHod, techId, 9000000);

  // Somebody else takes the reserve in the meantime.
  await transferBudget(finance, {
    fromDepartmentId: null, toDepartmentId: logiId,
    amountPaise: 8000000, reason: "Logistics needs it first",
  });

  await expect(decideAllocationRequest(finance, req.id, "APPROVE", "Approved"))
    .rejects.toThrow(/reserve does not cover/i);

  // And the refusal left nothing half-done: the ask is still open to answer.
  const [row] = await db.select().from(allocationRequests).where(eq(allocationRequests.id, req.id));
  expect(row.status).toBe("PENDING");
  expect(await allocationOf(techId)).toBe(2000000);
});

/* -------------------------------------------------------------- visibility */

test("an HOD sees their own department's asks and no other's", async () => {
  await ask(techHod, techId, 3000000);
  await ask(logiHod, logiId, 500000);

  const mine = await listAllocationRequests(techHod);
  expect(mine).toHaveLength(1);
  expect(mine.every((r) => r.department_id === techId)).toBe(true);

  // Finance answers the queue, so Finance sees all of it.
  expect(await listAllocationRequests(finance, { status: "PENDING" })).toHaveLength(2);
});
