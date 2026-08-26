/**
 * Ticket templates.
 *
 * The property worth holding down is that a template is **inert**. It fills a form
 * in and decides nothing: choosing one that names Logistics does not let a Member
 * raise with Logistics, and a template carrying a project from another fest is
 * refused at the point somebody tries to save it, not at the point somebody uses
 * it (18.2 rule 10).
 *
 * The rest is housekeeping that the repo asks of anything editable — one name per
 * fest, retired rather than deleted, and every change on the audit trail.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import {
  createCycle, createLabel, createProject, createTemplate, deleteCycle, deleteProject,
  listTemplates, retireTemplate, updateTemplate,
} from "@/lib/services/planning";

const PREFIX = "tpl-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, otherFestId: string, techId: string, logiId: string, financeDeptId: string;
let techHod: SessionUser, techMember: SessionUser, logiHod: SessionUser, finance: SessionUser;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

const mkFest = async (name: string) => (await one<{ id: string }>(sql`
  insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
  values (${name}, ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 10000000)
  returning id`)).id;

const van = (overrides: Partial<Parameters<typeof createTemplate>[1]> = {}) => ({
  name: "Van request",
  summary: "Booking a vehicle for a load-in or load-out",
  targetDepartmentId: logiId,
  title: "Van needed for load-in",
  body: "Pickup point:\nDrop point:\nWhat is being moved:",
  priority: "HIGH" as const,
  dueInHours: 48,
  ...overrides,
});

beforeEach(async () => {
  festId = await mkFest("Template Fest");
  otherFestId = await mkFest("Another Fest");

  const mkDept = async (fest: string, name: string, slug: string, kind: string) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${fest}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, 0) returning id`)).id;

  financeDeptId = await mkDept(festId, "Finance", "finance", "FINANCE");
  await mkDept(festId, "Core", "core", "CORE");
  techId = await mkDept(festId, "Tech", "tech", "BUDGET");
  logiId = await mkDept(festId, "Logistics", "logistics", "BUDGET");

  const mkUser = async (fest: string, email: string, role: SessionUser["role"], deptId: string) => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${fest}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE')
      returning id`)).id,
    festId: fest, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
  } as SessionUser);

  techHod = await mkUser(festId, "tech.hod@t.test", "DEPT_HOD", techId);
  techMember = await mkUser(festId, "tech.member@t.test", "MEMBER", techId);
  logiHod = await mkUser(festId, "logi.hod@t.test", "DEPT_HOD", logiId);
  finance = await mkUser(festId, "finance@t.test", "FINANCE_HOD", financeDeptId);
});

/* --------------------------------------------------------------- what it does */

test("a template carries everything a form would otherwise ask for twice", async () => {
  const project = await createProject(techHod, { name: "Main stage build" });
  const label = await createLabel(techHod, { name: "logistics" });

  const row = await createTemplate(techHod, van({
    projectId: project.id, labelIds: [label.id], location: "Gate 3",
  }));
  expect(row.name).toBe("Van request");

  const [seen] = await listTemplates(techHod);
  expect(seen).toMatchObject({
    name: "Van request",
    target_department: "Logistics",
    title: "Van needed for load-in",
    priority: "HIGH",
    due_in_hours: 48,
    project: "Main stage build",
    location: "Gate 3",
  });
  expect((seen.labels as { name: string }[]).map((l) => l.name)).toEqual(["logistics"]);
});

test("anyone who runs work can write one, and they are shared across departments", async () => {
  await createTemplate(logiHod, van());
  // A template Logistics wrote for "how to ask us for a van" is exactly the thing
  // Tech should pick up — same reasoning as labels.
  expect((await listTemplates(techHod)).map((t) => t.name)).toEqual(["Van request"]);
  expect((await listTemplates(finance)).map((t) => t.name)).toEqual(["Van request"]);
});

/* -------------------------------------------------------- what it does not do */

test("a Member is not offered a template they could not raise", async () => {
  await createTemplate(techHod, van());                                 // addressed to Logistics
  await createTemplate(techHod, van({ name: "Kit check", targetDepartmentId: techId }));
  await createTemplate(techHod, van({ name: "Anything", targetDepartmentId: null }));

  // A Member raises with their own head and nobody else, so a Logistics template
  // is not a choice they have. Offering it would mean a form that fills itself in
  // and then refuses to submit.
  expect((await listTemplates(techMember)).map((t) => t.name).sort())
    .toEqual(["Anything", "Kit check"]);

  // Everybody else sees all three.
  expect(await listTemplates(techHod)).toHaveLength(3);
});

test("a Member cannot write one", async () => {
  await expect(createTemplate(techMember, van())).rejects.toThrow(/not permitted/i);
});

test("a template cannot point at another fest's project", async () => {
  const otherDept = (await one<{ id: string }>(sql`
    insert into departments (fest_id, name, slug, kind, allocated_paise)
    values (${otherFestId}, 'Tech', 'tech-other', 'BUDGET', 0) returning id`)).id;
  const otherHod = {
    ...techHod,
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${otherFestId}, 'other@t.test', 'other', 'DEPT_HOD', ${otherDept}, 'ACTIVE') returning id`)).id,
    festId: otherFestId, departmentId: otherDept,
  } as SessionUser;
  const foreign = await createProject(otherHod, { name: "Their stage" });

  // A UUID is not a secret, and a template is a comfortable place to park a
  // reference to somebody else's fest and have this one render its name.
  await expect(createTemplate(techHod, van({ projectId: foreign.id })))
    .rejects.toThrow(/not found/i);
  await expect(createTemplate(techHod, van({ targetDepartmentId: otherDept })))
    .rejects.toThrow(/not found/i);
});

test("two live templates cannot share a name", async () => {
  await createTemplate(techHod, van());
  await expect(createTemplate(techHod, van({ summary: "again" })))
    .rejects.toThrow(/already a/i);
});

/* --------------------------------------------------------------- housekeeping */

test("editing changes only what was sent", async () => {
  const row = await createTemplate(techHod, van());
  const after = await updateTemplate(techHod, row.id, { priority: "URGENT" });

  expect(after.defaultPriority).toBe("URGENT");
  expect(after.title).toBe("Van needed for load-in");
  expect(after.dueInHours).toBe(48);
});

test("clearing a field is different from not sending it", async () => {
  const row = await createTemplate(techHod, van());
  const after = await updateTemplate(techHod, row.id, { dueInHours: null, targetDepartmentId: null });

  expect(after.dueInHours).toBeNull();
  expect(after.targetDepartmentId).toBeNull();
  expect(after.title).toBe("Van needed for load-in");
});

test("retiring is reversible, and the name comes free while it is retired", async () => {
  const row = await createTemplate(techHod, van());

  const retired = await retireTemplate(techHod, row.id);
  expect(retired.isActive).toBe(false);
  expect(await listTemplates(techHod)).toEqual([]);
  expect(await listTemplates(techHod, { all: true })).toHaveLength(1);

  // The name is free again, because the unique index only covers live ones.
  const replacement = await createTemplate(techHod, van({ summary: "the new one" }));
  expect(replacement.id).not.toBe(row.id);

  // …and restoring the old one is then refused rather than silently making two.
  await expect(retireTemplate(techHod, row.id)).rejects.toThrow();
});

test("every change is on the record", async () => {
  const row = await createTemplate(techHod, van());
  await updateTemplate(techHod, row.id, { priority: "LOW" });
  await retireTemplate(techHod, row.id);

  const trail = await db.select({ action: auditEvents.action }).from(auditEvents)
    .where(and(eq(auditEvents.entityType, "TICKET_TEMPLATE"), eq(auditEvents.entityId, row.id)))
    .orderBy(auditEvents.createdAt);
  expect(trail.map((t) => t.action))
    .toEqual(["template.create", "template.update", "template.retire"]);
});

/**
 * A cycle is hard-deleted, and a template that still pointed at it would take the
 * delete down with a foreign key error — one department tidying its calendar
 * breaking another department's template.
 */
test("deleting a cycle unfiles the templates that used it", async () => {
  const cycle = await createCycle(techHod, {
    name: "Setup week", startsOn: "2026-11-20", endsOn: "2026-11-26",
  });
  const row = await createTemplate(techHod, van({ cycleId: cycle.id }));

  await expect(deleteCycle(techHod, cycle.id)).resolves.toEqual({ ok: true });
  expect((await listTemplates(techHod)).find((t) => t.id === row.id)).toMatchObject({ cycle_id: null });
});

/** A retired project should not keep showing its name on a template that named it. */
test("retiring a project unfiles it from the template's display", async () => {
  const project = await createProject(techHod, { name: "Main stage build" });
  const row = await createTemplate(techHod, van({ projectId: project.id }));
  await deleteProject(techHod, project.id);

  expect((await listTemplates(techHod)).find((t) => t.id === row.id))
    .toMatchObject({ project: null });
});

test("another fest's template id is not a handle on it", async () => {
  await expect(updateTemplate(techHod, crypto.randomUUID(), { name: "Nope" }))
    .rejects.toThrow(/not found/i);
  expect(financeDeptId).toBeTruthy();
});
