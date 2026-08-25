/**
 * The Linear-shaped planning layer on top of PRD 7.7's state machine.
 *
 * The thing worth proving is the boundary: labels, projects, cycles and sub-tickets
 * change how work is grouped and never who may do what. So the tests below check
 * that a Backlog decision is still a triage decision, that a planning reference
 * from another fest is refused like any other foreign id (18.2 rule 10), and that
 * retiring a project leaves its tickets exactly where they were.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { tickets } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import { createTicket, getTicketDetail, listTickets, transitionTicket, updateTicket } from "@/lib/services/tickets";
import {
  createCycle, createLabel, createProject, deleteLabel, deleteProject, listLabels,
} from "@/lib/services/planning";

const PREFIX = "plan-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string;
let techMember: SessionUser, techHod: SessionUser, logiHod: SessionUser, logiMember: SessionUser, finance: SessionUser;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

const ask = (overrides: Partial<Parameters<typeof createTicket>[1]> = {}) => ({
  title: "40 chairs to Audi B before 4pm",
  description: "Stacked at the back entrance is fine; we will place them.",
  targetDepartmentId: logiId,
  dueAt: "2026-11-27T16:00:00+05:30",
  priority: "HIGH" as const,
  ...overrides,
});

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Planning Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 10000000)
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, 0) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET");
  logiId = await mkDept("Logistics", "logistics", "BUDGET");

  const mkUser = async (email: string, role: SessionUser["role"], deptId: string) => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE')
      returning id`)).id,
    festId, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
  } as SessionUser);

  techMember = await mkUser("tech.member@p.test", "MEMBER", techId);
  techHod = await mkUser("tech.hod@p.test", "DEPT_HOD", techId);
  logiHod = await mkUser("logi.hod@p.test", "DEPT_HOD", logiId);
  logiMember = await mkUser("logi.member@p.test", "MEMBER", logiId);
  finance = await mkUser("finance@p.test", "FINANCE_HOD", financeDeptId);
});

/* ------------------------------------------------------------------- backlog */

/**
 * Backlog is the third answer to a triage decision, and the one that was missing.
 * Without it a department either takes on work it cannot schedule or rejects work
 * it intends to do — and the inbox count stops meaning anything either way.
 */
test("the target HOD can backlog a ticket instead of accepting or rejecting it", async () => {
  const t = await createTicket(techMember, ask());
  const after = await transitionTicket(logiHod, t.id, "BACKLOG");
  expect(after.status).toBe("BACKLOG");
});

test("backlogging is a triage decision, so only the target department may do it", async () => {
  const t = await createTicket(techMember, ask());
  await expect(transitionTicket(techHod, t.id, "BACKLOG")).rejects.toThrow(/may not BACKLOG|not permitted/i);
  await expect(transitionTicket(logiMember, t.id, "BACKLOG")).rejects.toThrow(/BACKLOG|not permitted/i);
});

test("a backlogged ticket schedules into Todo, and can go back", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "BACKLOG");
  expect((await transitionTicket(logiHod, t.id, "SCHEDULE")).status).toBe("ACCEPTED");
  expect((await transitionTicket(logiHod, t.id, "BACKLOG")).status).toBe("BACKLOG");
});

test("a backlogged ticket cannot be started without being scheduled first", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "BACKLOG");
  await expect(transitionTicket(logiHod, t.id, "START"))
    .rejects.toThrow(/not allowed from BACKLOG/i);
});

test("the requester can still cancel from the backlog", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "BACKLOG");
  expect((await transitionTicket(techMember, t.id, "CANCEL")).status).toBe("CANCELLED");
});

/* -------------------------------------------------------------------- labels */

test("labels are fest-wide and shared between departments", async () => {
  const label = await createLabel(logiHod, { name: "Needs a van", color: "#d2fc3c" });
  const t = await createTicket(techMember, ask({ labelIds: [label.id] }));

  const detail = await getTicketDetail(techMember, t.id);
  expect(detail.labels.map((l) => l.name)).toEqual(["Needs a van"]);

  // And a different department can use it on their own work.
  expect((await listLabels(techHod)).find((l) => l.id === label.id)?.ticket_count).toBe(1);
});

test("a Member cannot invent labels, which is what keeps the vocabulary shared", async () => {
  await expect(createLabel(techMember, { name: "sound" })).rejects.toThrow(/not permitted/i);
});

test("labels are set as a whole set, so removing one is just a shorter list", async () => {
  const a = await createLabel(finance, { name: "Urgent hire" });
  const b = await createLabel(finance, { name: "Outdoors" });
  const t = await createTicket(techMember, ask({ labelIds: [a.id, b.id] }));

  await updateTicket(techMember, t.id, { labelIds: [b.id] });
  expect((await getTicketDetail(techMember, t.id)).labels.map((l) => l.name)).toEqual(["Outdoors"]);

  await updateTicket(techMember, t.id, { labelIds: [] });
  expect((await getTicketDetail(techMember, t.id)).labels).toHaveLength(0);
});

test("deleting a label takes it off its tickets and leaves them otherwise alone", async () => {
  const label = await createLabel(finance, { name: "Temporary" });
  const t = await createTicket(techMember, ask({ labelIds: [label.id] }));

  await deleteLabel(finance, label.id);

  const detail = await getTicketDetail(techMember, t.id);
  expect(detail.labels).toHaveLength(0);
  expect(detail.status).toBe("OPEN");
});

test("a duplicate label name is refused however it is cased", async () => {
  await createLabel(finance, { name: "Sound" });
  await expect(createLabel(finance, { name: "sound" })).rejects.toThrow(/already/i);
});

/* --------------------------------------------------------- projects and cycles */

test("retiring a project leaves its tickets on their boards, unfiled", async () => {
  const project = await createProject(finance, { name: "Main stage build" });
  const t = await createTicket(techMember, ask({ projectId: project.id }));

  await deleteProject(finance, project.id);

  const [row] = await db.select().from(tickets).where(eq(tickets.id, t.id));
  expect(row.projectId).toBeNull();
  expect(row.deletedAt).toBeNull();
  expect(row.status).toBe("OPEN");
});

test("a cycle groups work by a window, and filters to it", async () => {
  const cycle = await createCycle(finance, {
    name: "Setup week", startsOn: "2026-11-20", endsOn: "2026-11-26",
  });
  const inCycle = await createTicket(techMember, ask({ cycleId: cycle.id }));
  await createTicket(techMember, ask({ title: "Something else entirely, please" }));

  const filtered = await listTickets(logiHod, { view: "inbox", cycleId: cycle.id });
  expect(filtered.map((r) => r.id)).toEqual([inCycle.id]);
});

/**
 * These three filters all bind a list, and a list is where the SQL layer is most
 * likely to go wrong quietly: drizzle renders a JS array as a tuple, so the
 * natural-looking `= any(${ids}::uuid[])` asks Postgres to cast a record to an
 * array and 500s. Nothing above would have caught it — a filter that throws looks
 * the same as a filter nobody wrote a test for.
 */
test("list filters that take several values actually run", async () => {
  const label = await createLabel(finance, { name: "Needs a van" });
  const project = await createProject(finance, { name: "Main stage build" });
  const tagged = await createTicket(techMember, ask({ labelIds: [label.id], projectId: project.id }));
  const plain = await createTicket(techMember, ask({ title: "Something else entirely, please" }));
  await transitionTicket(logiHod, plain.id, "BACKLOG");

  expect((await listTickets(logiHod, { view: "inbox", labelIds: [label.id] })).map((r) => r.id))
    .toEqual([tagged.id]);
  expect((await listTickets(logiHod, { view: "inbox", status: ["BACKLOG"] })).map((r) => r.id))
    .toEqual([plain.id]);
  expect((await listTickets(logiHod, { view: "inbox", categories: ["TRIAGE"] })).map((r) => r.id))
    .toEqual([tagged.id]);
  // A column that collapses several statuses has to match all of them.
  expect((await listTickets(logiHod, { view: "inbox", categories: ["TRIAGE", "BACKLOG"] })).map((r) => r.id).sort())
    .toEqual([tagged.id, plain.id].sort());
  // An empty list is not a filter — it must not become `in ()`.
  expect(await listTickets(logiHod, { view: "inbox", labelIds: [], categories: [] })).toHaveLength(2);
});

test("a listed ticket's due date is a real Date, not a string wearing the type", async () => {
  // The board serialises it across the client boundary with `.toISOString()`, and a
  // raw `db.execute` can hand back either — so the coercion is the contract.
  await createTicket(techMember, ask());
  const [row] = await listTickets(logiHod, { view: "inbox" });
  expect(row.due_at).toBeInstanceOf(Date);
  expect(() => row.due_at.toISOString()).not.toThrow();
});

test("a cycle cannot end before it starts", async () => {
  await expect(createCycle(finance, { name: "Backwards", startsOn: "2026-11-26", endsOn: "2026-11-20" }))
    .rejects.toThrow(/cannot end before/i);
});

/* ---------------------------------------------------------------- sub-tickets */

test("a sub-ticket rolls up to its parent", async () => {
  const parent = await createTicket(techMember, ask({ title: "Set up the main stage properly" }));
  const child = await createTicket(techMember, ask({ title: "Chairs for the main stage", parentId: parent.id }));

  const detail = await getTicketDetail(techMember, parent.id);
  expect(detail.children.map((c) => c.id)).toEqual([child.id]);

  const [row] = (await listTickets(techMember, { view: "created" })).filter((r) => r.id === parent.id);
  expect(row.child_count).toBe(1);
  expect(row.child_done_count).toBe(0);
});

/**
 * One level only. A tree of sub-tickets is a project, and there is a table for
 * that; nesting deeper mainly produces boards nobody can read.
 */
test("sub-tickets go one level deep", async () => {
  const parent = await createTicket(techMember, ask({ title: "Set up the main stage properly" }));
  const child = await createTicket(techMember, ask({ title: "Chairs for the main stage", parentId: parent.id }));

  await expect(createTicket(techMember, ask({ title: "A grandchild ticket here", parentId: child.id })))
    .rejects.toThrow(/one level deep/i);
});

test("a ticket with children cannot itself become a sub-ticket", async () => {
  const parent = await createTicket(techMember, ask({ title: "Set up the main stage properly" }));
  await createTicket(techMember, ask({ title: "Chairs for the main stage", parentId: parent.id }));
  const other = await createTicket(techMember, ask({ title: "An unrelated request here" }));

  await expect(updateTicket(techMember, parent.id, { parentId: other.id }))
    .rejects.toThrow(/sub-tickets of its own/i);
});

test("a ticket cannot be its own parent", async () => {
  const t = await createTicket(techMember, ask());
  await expect(updateTicket(techMember, t.id, { parentId: t.id })).rejects.toThrow(/own parent/i);
});

/* ------------------------------------------------------- who may file a ticket */

/**
 * Planning fields answer to neither the requester rule nor the triage rule: they
 * say nothing about what was asked or who owes it. Anyone on the ticket may set
 * them — gating them behind triage would mean the person doing the work cannot tag
 * their own ticket, which is how tags die.
 */
test("the requester can file their own ticket even after it is accepted", async () => {
  const project = await createProject(finance, { name: "Main stage build" });
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "ACCEPT");

  // Rewording is closed off at this point…
  await expect(updateTicket(techMember, t.id, { title: "Something different now" }))
    .rejects.toThrow(/before it is accepted/i);
  // …but filing is not.
  await expect(updateTicket(techMember, t.id, { projectId: project.id })).resolves.toBeTruthy();
});

test("somebody with no part in a ticket cannot file it", async () => {
  const project = await createProject(finance, { name: "Main stage build" });
  const t = await createTicket(techMember, ask());
  // Finance can see every ticket, and still has no business filing this one.
  await expect(updateTicket(finance, t.id, { projectId: project.id }))
    .rejects.toThrow(/somebody on this ticket/i);
});

/* ------------------------------------------------------------- fest isolation */

test("a project from another fest is not found", async () => {
  const otherFest = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end)
    values ('Other', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14')
    returning id`)).id;
  const otherDept = (await one<{ id: string }>(sql`
    insert into departments (fest_id, name, slug, kind) values (${otherFest}, 'Tech', 'tech', 'BUDGET')
    returning id`)).id;
  const otherUser = (await one<{ id: string }>(sql`
    insert into users (fest_id, email, name, role, department_id, status)
    values (${otherFest}, 'x@p.test', 'x', 'FINANCE_HOD', ${otherDept}, 'ACTIVE') returning id`)).id;
  const foreign = (await one<{ id: string }>(sql`
    insert into projects (fest_id, name, created_by) values (${otherFest}, 'Theirs', ${otherUser})
    returning id`)).id;

  // `ticket.plan` says nothing about *which* project, so `can()` cannot catch this.
  await expect(createTicket(techMember, ask({ projectId: foreign })))
    .rejects.toThrow(/project/i);
});
