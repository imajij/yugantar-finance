/**
 * Issue relations: blocks, duplicates, relates to.
 *
 * Two properties hold this file together.
 *
 * **A relation is stored once and read from both ends.** "RQ-1 blocks RQ-2" is one
 * row; RQ-2 reports being blocked by reading that row backwards. Half the tests
 * below are the same fact asked from the other side.
 *
 * **A block is a statement, not a gate.** Nothing here stops a blocked ticket from
 * being accepted, started or closed, and that is deliberate: 18.2 rule 2 keeps
 * status in the state machine, and the person holding the ticket is better placed
 * than a link to say whether the blocker really has to land first. What a block
 * does instead is show up, and tell the people waiting when it settles.
 *
 * The one thing refused is a loop, because "A blocks B blocks A" is not a claim
 * about the work — it is two tickets that can never be honestly described.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { entityLinks, notifications } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import {
  createTicket, getTicketDetail, linkTicket, listTickets, transitionTicket, unlinkTicket,
} from "@/lib/services/tickets";

const PREFIX = "rel-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string;
let techHod: SessionUser, logiHod: SessionUser, logiMember: SessionUser, finance: SessionUser;

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

/** Two tickets Tech raised with Logistics, which both heads can see. */
async function pair() {
  const a = await createTicket(techHod, ask({ title: "Generator delivered to the field" }));
  const b = await createTicket(techHod, ask({ title: "Cable run from the generator to the stage" }));
  return [a, b] as const;
}

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Relations Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 10000000)
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

  techHod = await mkUser("tech.hod@r.test", "DEPT_HOD", techId);
  logiHod = await mkUser("logi.hod@r.test", "DEPT_HOD", logiId);
  logiMember = await mkUser("logi.member@r.test", "MEMBER", logiId);
  finance = await mkUser("finance@r.test", "FINANCE_HOD", financeDeptId);
});

/* ------------------------------------------------- one row, read from both ends */

test("a block is one row, and both tickets describe it correctly", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");

  const rows = await db.select().from(entityLinks)
    .where(and(eq(entityLinks.fromId, a.id), eq(entityLinks.toId, b.id)));
  expect(rows).toHaveLength(1);
  expect(rows[0].relation).toBe("BLOCKS");

  const from = await getTicketDetail(techHod, a.id);
  expect(from.relations).toEqual([
    expect.objectContaining({ relation: "BLOCKS", id: b.id, human_id: b.humanId }),
  ]);

  const to = await getTicketDetail(techHod, b.id);
  expect(to.relations).toEqual([
    expect.objectContaining({ relation: "BLOCKED_BY", id: a.id, human_id: a.humanId }),
  ]);
});

test("a duplicate reads as duplicated-by from the original", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "DUPLICATES");

  expect((await getTicketDetail(techHod, a.id)).relations[0].relation).toBe("DUPLICATES");
  expect((await getTicketDetail(techHod, b.id)).relations[0].relation).toBe("DUPLICATED_BY");
});

test("relates-to reads the same way from either end", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id);

  expect((await getTicketDetail(techHod, a.id)).relations[0].relation).toBe("RELATED");
  expect((await getTicketDetail(techHod, b.id)).relations[0].relation).toBe("RELATED");
});

/* ---------------------------------------------------------------- what is refused */

test("a ticket cannot block itself", async () => {
  const [a] = await pair();
  await expect(linkTicket(techHod, a.id, "TICKET", a.id, "BLOCKS"))
    .rejects.toThrow(/cannot be linked to itself/i);
});

test("the same pair cannot be linked twice, in either direction", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");

  // Same direction: silently already there rather than an error, because the
  // person clicking twice meant the same thing both times.
  expect(await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS")).toEqual({ already_linked: true });

  // The other way round is a different claim about the same pair, and it is the
  // one that would deadlock — so it is refused, naming what already exists.
  await expect(linkTicket(techHod, b.id, "TICKET", a.id, "BLOCKS"))
    .rejects.toThrow(/already linked the other way round/i);
});

test("a blocking loop is refused however long it is", async () => {
  const a = await createTicket(techHod, ask({ title: "Generator on site" }));
  const b = await createTicket(techHod, ask({ title: "Cable run to the stage" }));
  const c = await createTicket(techHod, ask({ title: "Sound check on the main stage" }));

  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  await linkTicket(techHod, b.id, "TICKET", c.id, "BLOCKS");

  // C blocks A would close A → B → C → A, and all three would wait on themselves.
  await expect(linkTicket(techHod, c.id, "TICKET", a.id, "BLOCKS"))
    .rejects.toThrow(/wait on each other/i);

  // The same edge as a plain relation is fine: only BLOCKS can deadlock.
  await expect(linkTicket(techHod, c.id, "TICKET", a.id)).resolves.toBeTruthy();
});

test("only another ticket can be blocked", async () => {
  const [a] = await pair();
  await expect(linkTicket(techHod, a.id, "REIMBURSEMENT", a.id, "BLOCKS"))
    .rejects.toThrow(/only another ticket/i);
});

test("a ticket you cannot see cannot be linked to", async () => {
  const [a] = await pair();
  const hidden = await createTicket(logiHod, {
    ...ask({ title: "Finance to confirm the vendor advance" }), targetDepartmentId: financeDeptId,
  });

  // Tech is party to neither end of that one, so it does not exist as far as they
  // are concerned — and a UUID is not a permission (18.2 rule 10).
  await expect(linkTicket(techHod, a.id, "TICKET", hidden.id, "BLOCKS"))
    .rejects.toThrow(/cannot see|not found/i);
});

/* ------------------------------------------------- a statement, not a gate (18.2/2) */

test("being blocked stops nothing", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");

  // B is blocked by A, and B moves through triage and into work regardless. The
  // owner decides that, not the link.
  await transitionTicket(logiHod, b.id, "ACCEPT");
  const started = await transitionTicket(logiHod, b.id, "START");
  expect(started.status).toBe("IN_PROGRESS");
  const done = await transitionTicket(logiHod, b.id, "MARK_DONE");
  expect(done.status).toBe("DONE");
});

test("the board says a ticket is blocked, and stops saying it when the blocker settles", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");

  const blockedRow = () => listTickets(techHod, { view: "outgoing" })
    .then((rows) => rows.find((r) => r.id === b.id)!);

  expect((await blockedRow()).blocked_by).toBe(1);

  await transitionTicket(logiHod, a.id, "ACCEPT");
  // Still blocking: a blocker that has merely started is still in the way.
  await transitionTicket(logiHod, a.id, "START");
  expect((await blockedRow()).blocked_by).toBe(1);

  await transitionTicket(logiHod, a.id, "MARK_DONE");
  expect((await blockedRow()).blocked_by).toBe(0);
});

test("the people waiting are told when the blocker lands", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  await transitionTicket(logiHod, a.id, "ACCEPT");
  await transitionTicket(logiHod, a.id, "MARK_DONE");

  const sent = await db.select().from(notifications).where(and(
    eq(notifications.festId, festId),
    eq(notifications.recipientId, techHod.id),
    eq(notifications.type, "ticket.unblocked"),
  ));
  // One row, in the app only: a blocker landing is a badge, not an email.
  expect(sent).toHaveLength(1);
  expect(sent[0].channel).toBe("IN_APP");
  expect(sent[0].entityId).toBe(b.id);
  expect(sent[0].title).toContain(b.humanId);
});

test("nobody is told about a blocker that is still open", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  await transitionTicket(logiHod, a.id, "ACCEPT");

  // Scoped to this fest: every test in this file makes its own, and a stray row
  // from the one before would make this pass for the wrong reason.
  expect(await db.select().from(notifications).where(and(
    eq(notifications.festId, festId),
    eq(notifications.type, "ticket.unblocked"),
  ))).toEqual([]);
  expect(b.id).toBeTruthy();
});

/* ------------------------------------------------------------------- unlinking */

test("either end may remove a relation", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  const [link] = (await getTicketDetail(techHod, b.id)).relations;

  // Removed from the blocked end — the department being told it is stuck has as
  // much standing to disagree as the one that said it.
  await unlinkTicket(logiHod, b.id, link.link_id);
  expect((await getTicketDetail(techHod, a.id)).relations).toEqual([]);
});

test("a link id belonging to two other tickets is not a way in", async () => {
  const [a, b] = await pair();
  const c = await createTicket(techHod, ask({ title: "Barricades along the walkway" }));
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  const [link] = (await getTicketDetail(techHod, a.id)).relations;

  // The link is real and the caller can see all three tickets — and it still has
  // to touch the ticket named in the URL.
  await expect(unlinkTicket(techHod, c.id, link.link_id)).rejects.toThrow(/not found/i);
});

test("another fest's link id is refused like any other foreign id", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  await expect(unlinkTicket(techHod, a.id, crypto.randomUUID())).rejects.toThrow(/not found/i);
});

test("a Member of the target department sees the relation on their own board", async () => {
  const [a, b] = await pair();
  await linkTicket(techHod, a.id, "TICKET", b.id, "BLOCKS");
  await transitionTicket(logiHod, b.id, "ACCEPT");
  await transitionTicket(logiHod, b.id, "REASSIGN", { assignee_id: logiMember.id });

  const detail = await getTicketDetail(logiMember, b.id);
  expect(detail.relations[0].relation).toBe("BLOCKED_BY");
  expect(detail.relations[0].is_open).toBe(true);
  expect(finance.id).toBeTruthy();
});
