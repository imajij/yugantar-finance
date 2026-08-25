/**
 * PRD 8.3 — a person raising a concern, rather than a rule finding one.
 *
 * The rules (F1–F14) examine records with numbers in them. What they cannot see is
 * the thing somebody notices about a *department* or a *person*: a team sitting on
 * unreviewed line items, an HOD whose claims all arrive on the last day. This pins
 * down that those land in the same queue, scope to the same departments, and cannot
 * quietly evaporate.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { flags } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import { listFlags, openFlagCounts, raiseFlag, resolveFlag, withdrawFlag } from "@/lib/services/flags";

const PREFIX = "mflag-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string, coreId: string;
let techHod: SessionUser, logiHod: SessionUser, techMember: SessionUser, finance: SessionUser, mgmt: SessionUser;
let techLineItemId: string;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Flag Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 10000000)
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string, allocated = 0) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, ${allocated})
      returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET", 2000000);
  logiId = await mkDept("Logistics", "logistics", "BUDGET", 1000000);

  const mkUser = async (email: string, role: SessionUser["role"], deptId: string) => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE')
      returning id`)).id,
    festId, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
  } as SessionUser);

  techMember = await mkUser("tech.member@f.test", "MEMBER", techId);
  techHod = await mkUser("tech.hod@f.test", "DEPT_HOD", techId);
  logiHod = await mkUser("logi.hod@f.test", "DEPT_HOD", logiId);
  finance = await mkUser("finance@f.test", "FINANCE_HOD", financeDeptId);
  mgmt = await mkUser("mgmt@f.test", "MANAGEMENT", coreId);

  techLineItemId = (await one<{ id: string }>(sql`
    insert into line_items (fest_id, department_id, name, planned_paise, created_by)
    values (${festId}, ${techId}, 'Sound system', 500000, ${techHod.id}) returning id`)).id;
});

const concern = (actor: SessionUser, entityType: Parameters<typeof raiseFlag>[1]["entityType"], entityId: string) =>
  raiseFlag(actor, {
    entityType, entityId, severity: "MEDIUM",
    explanation: "This has been sitting untouched for a fortnight and nobody can say why",
  });

/* --------------------------------------------------------------- who may raise */

test("a Member cannot raise a concern — 8.3 is an oversight tool", async () => {
  await expect(concern(techMember, "LINE_ITEM", techLineItemId)).rejects.toThrow(/not permitted/i);
});

test("an HOD raises one on their own department's line item", async () => {
  const flag = await concern(techHod, "LINE_ITEM", techLineItemId);
  expect(flag.rule).toBe("MANUAL");
  expect(flag.raisedBy).toBe(techHod.id);
  expect(flag.status).toBe("OPEN");
});

test("an HOD cannot flag another department's line item", async () => {
  await expect(concern(logiHod, "LINE_ITEM", techLineItemId)).rejects.toThrow(/cannot see/i);
});

/* ----------------------------------------------- departments and people as targets */

test("a department can be flagged, and it scopes to itself", async () => {
  await concern(finance, "DEPARTMENT", techId);

  // Tech's HOD sees it because it is about Tech; Logistics' HOD does not.
  const forTech = await listFlags(techHod);
  expect(forTech).toHaveLength(1);
  expect(String(forTech[0].entity_type)).toBe("DEPARTMENT");
  expect(String(forTech[0].department_name)).toBe("Tech");

  expect(await listFlags(logiHod)).toHaveLength(0);
});

test("a person can be flagged, and it scopes to their department", async () => {
  await concern(finance, "USER", techHod.id);

  const forTech = await listFlags(techHod);
  expect(forTech).toHaveLength(1);
  expect(String(forTech[0].human_id)).toBe(techHod.name);
  expect(await listFlags(logiHod)).toHaveLength(0);
});

test("an HOD cannot flag somebody in another department", async () => {
  await expect(concern(techHod, "USER", logiHod.id)).rejects.toThrow(/cannot see/i);
});

test("flags on departments and people count toward the queue like any other", async () => {
  await concern(finance, "DEPARTMENT", techId);
  await concern(finance, "USER", techHod.id);
  await concern(finance, "LINE_ITEM", techLineItemId);

  expect((await openFlagCounts(finance)).total).toBe(3);
  expect((await openFlagCounts(techHod)).total).toBe(3);
  expect((await openFlagCounts(logiHod)).total).toBe(0);
});

/* ------------------------------------------------------------------ duplicates */

/**
 * A rule re-running must not pile up duplicates, which is what the partial unique
 * index is for. Hand-raised flags are the opposite case, so the index excludes
 * them — two people noticing two different things about one record is the point.
 */
test("two people can raise separate concerns about the same record", async () => {
  await concern(techHod, "LINE_ITEM", techLineItemId);
  await concern(finance, "LINE_ITEM", techLineItemId);

  const open = await db.select().from(flags)
    .where(and(eq(flags.entityId, techLineItemId), eq(flags.status, "OPEN")));
  expect(open).toHaveLength(2);
});

/* -------------------------------------------------------------- resolving them */

test("clearing somebody's concern is still Finance's call", async () => {
  const flag = await concern(techHod, "LINE_ITEM", techLineItemId);
  await expect(resolveFlag(techHod, flag.id, "DISMISS", "never mind"))
    .rejects.toThrow(/not permitted/i);
  await expect(resolveFlag(finance, flag.id, "ACKNOWLEDGE", "Checked the quote; it stands"))
    .resolves.toBeTruthy();
});

test("the person who raised one may withdraw it, and nobody else may", async () => {
  const flag = await concern(techHod, "LINE_ITEM", techLineItemId);

  await expect(withdrawFlag(mgmt, flag.id, "not mine to take back"))
    .rejects.toThrow(/only whoever raised/i);

  const after = await withdrawFlag(techHod, flag.id, "Answered in the comments five minutes later");
  expect(after.status).toBe("DISMISSED");
  // Withdrawn, not vanished: the note says who and why, like every other resolution.
  expect(after.resolutionNote).toContain("Answered in the comments");
  expect(after.resolutionNote).toContain(techHod.name);
});

test("a withdrawal needs a reason", async () => {
  const flag = await concern(techHod, "LINE_ITEM", techLineItemId);
  await expect(withdrawFlag(techHod, flag.id, "  ")).rejects.toThrow(/why/i);
});

test("a resolved concern cannot be withdrawn afterwards", async () => {
  const flag = await concern(techHod, "LINE_ITEM", techLineItemId);
  await resolveFlag(finance, flag.id, "ACKNOWLEDGE", "Looked at it, it is fine");
  await expect(withdrawFlag(techHod, flag.id, "actually"))
    .rejects.toThrow(/already acknowledged/i);
});

/* ------------------------------------------------------------------ filtering */

test("the queue can be read as rules-only or people-only", async () => {
  await concern(finance, "DEPARTMENT", techId);

  expect(await listFlags(finance, { source: "MANUAL" })).toHaveLength(1);
  expect(await listFlags(finance, { source: "RULE" })).toHaveLength(0);
});

test("an explanation has to say something", async () => {
  await expect(raiseFlag(finance, {
    entityType: "DEPARTMENT", entityId: techId, severity: "LOW", explanation: "bad",
  })).rejects.toThrow(/at least 10/i);
});

test("a target from outside the fest is not found, not forbidden", async () => {
  await expect(raiseFlag(finance, {
    entityType: "DEPARTMENT", entityId: crypto.randomUUID(),
    severity: "LOW", explanation: "Something is wrong over there",
  })).rejects.toThrow(/not found|department/i);
});
