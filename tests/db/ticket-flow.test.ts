/**
 * PRD 7.7 — work tickets. What this pins down: NEEDS_INFO returns to wherever it
 * came from, escalation marks without moving state, only the target department
 * triages, and only the requester closes.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";

afterAll(() => dropFests(db, "tick-"));
import {
  createTicket, getTicketDetail, listTickets, ticketCounts, transitionTicket,
} from "@/lib/services/tickets";

let festId: string, techId: string, logiId: string, financeDeptId: string, coreId: string;
let techMember: SessionUser, techHod: SessionUser, logiHod: SessionUser, logiMember: SessionUser, mgmt: SessionUser;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

const ask = (overrides: Partial<Parameters<typeof createTicket>[1]> = {}) => ({
  title: "40 chairs to Audi B before 4pm",
  description: "Stacked at the back entrance is fine; we will place them.",
  targetDepartmentId: logiId,
  dueAt: "2026-11-27T16:00:00+05:30",
  priority: "HIGH" as const,
  location: "Audi B",
  ...overrides,
});

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end, total_budget_paise)
    values ('Ticket Fest', 'tick-' || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14', 100000000)
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind, allocated_paise)
      values (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}, 0) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET");
  logiId = await mkDept("Logistics", "logistics", "BUDGET");

  const mkUser = async (email: string, role: SessionUser["role"], deptId: string): Promise<SessionUser> => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE') returning id`)).id,
    festId, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
  } as SessionUser);

  techMember = await mkUser("tech.member@t.test", "MEMBER", techId);
  techHod = await mkUser("tech.hod@t.test", "DEPT_HOD", techId);
  logiHod = await mkUser("logi.hod@t.test", "DEPT_HOD", logiId);
  logiMember = await mkUser("logi.member@t.test", "MEMBER", logiId);
  mgmt = await mkUser("mg@t.test", "MANAGEMENT", coreId);
});

test("the happy path: accept, start, done, confirmed by the requester", async () => {
  const t = await createTicket(techMember, ask());
  expect(t.status).toBe("OPEN");
  expect(t.humanId).toMatch(/^YUG-\d+$/);

  await transitionTicket(logiHod, t.id, "ACCEPT");
  let detail = await getTicketDetail(techMember, t.id);
  expect(detail.status).toBe("ACCEPTED");
  expect(detail.assigneeId).toBe(logiHod.id);      // accepting without naming someone takes it

  await transitionTicket(logiHod, t.id, "START");
  await transitionTicket(logiHod, t.id, "MARK_DONE");
  detail = await getTicketDetail(techMember, t.id);
  expect(detail.status).toBe("DONE");

  // Only the requester closes it — the doer saying "done" is not the same as done.
  await expect(transitionTicket(logiHod, t.id, "CONFIRM")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await transitionTicket(techMember, t.id, "CONFIRM");
  expect((await getTicketDetail(techMember, t.id)).status).toBe("CLOSED");
});

test("NEEDS_INFO returns the ticket to wherever it was asked from", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "ACCEPT");
  await transitionTicket(logiHod, t.id, "START");

  await transitionTicket(logiHod, t.id, "ASK_INFO", { question: "Which entrance?" });
  let detail = await getTicketDetail(techMember, t.id);
  expect(detail.status).toBe("NEEDS_INFO");
  expect(detail.infoRequest).toBe("Which entrance?");

  await transitionTicket(techMember, t.id, "REPLY_INFO", { answer: "The back one" });
  detail = await getTicketDetail(techMember, t.id);
  expect(detail.status).toBe("IN_PROGRESS");        // not OPEN — back where it was
  expect(detail.infoRequest).toBeNull();
});

test("escalation marks the ticket without moving it", async () => {
  const t = await createTicket(techMember, ask());
  const after = await transitionTicket(techHod, t.id, "ESCALATE");
  expect(after.status).toBe("OPEN");
  expect(after.escalatedAt).not.toBeNull();
});

test("only the target department triages, and only its own people take the work", async () => {
  const t = await createTicket(techMember, ask());

  // The requesting department's own HOD has the role but not the standing to accept.
  await expect(transitionTicket(techHod, t.id, "ACCEPT")).rejects.toMatchObject({ code: "FORBIDDEN" });
  await transitionTicket(logiHod, t.id, "ACCEPT");

  await expect(transitionTicket(logiHod, t.id, "REASSIGN", { assignee_id: techMember.id }))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });

  const reassigned = await transitionTicket(logiHod, t.id, "REASSIGN", { assignee_id: logiMember.id });
  expect(reassigned.assigneeId).toBe(logiMember.id);
});

test("blocking needs a reason and unblocking clears it", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "ACCEPT");
  await transitionTicket(logiHod, t.id, "START");

  await expect(transitionTicket(logiHod, t.id, "BLOCK")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

  const blocked = await transitionTicket(logiHod, t.id, "BLOCK", { reason: "truck is late" });
  expect(blocked.status).toBe("BLOCKED");
  expect(blocked.blockedReason).toBe("truck is late");

  const unblocked = await transitionTicket(logiHod, t.id, "UNBLOCK");
  expect(unblocked.status).toBe("IN_PROGRESS");
  expect(unblocked.blockedReason).toBeNull();
});

test("a ticket cannot be raised against your own department", async () => {
  await expect(createTicket(techMember, ask({ targetDepartmentId: techId })))
    .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
});

test("reopening a done ticket puts it back in progress", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "ACCEPT");
  await transitionTicket(logiHod, t.id, "MARK_DONE");

  const reopened = await transitionTicket(techMember, t.id, "REOPEN", { reason: "only 20 chairs arrived" });
  expect(reopened.status).toBe("IN_PROGRESS");
  expect(reopened.doneAt).toBeNull();
});

test("the boards separate inbox, outgoing and mine", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "ACCEPT");
  await transitionTicket(logiHod, t.id, "REASSIGN", { assignee_id: logiMember.id });

  expect((await listTickets(logiHod, { view: "inbox" })).map((r) => r.id)).toContain(t.id);
  expect((await listTickets(techMember, { view: "outgoing" })).map((r) => r.id)).toContain(t.id);
  expect((await listTickets(logiMember, { view: "mine" })).map((r) => r.id)).toContain(t.id);
  expect((await listTickets(techMember, { view: "inbox" })).map((r) => r.id)).not.toContain(t.id);

  const counts = await ticketCounts(logiHod);
  expect(counts.inbox).toBe(1);
  expect(counts.untriaged).toBe(0);
});

test("outsiders cannot see a ticket between two other departments", async () => {
  const t = await createTicket(techMember, ask());
  const outsider = { ...techMember, id: (await one<{ id: string }>(sql`
    insert into users (fest_id, email, name, role, department_id, status)
    values (${festId}, 'nosy@t.test', 'Nosy', 'MEMBER', ${financeDeptId}, 'ACTIVE') returning id`)).id,
    departmentId: financeDeptId } as SessionUser;

  await expect(getTicketDetail(outsider, t.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
  // Management sees everything (5.1).
  expect((await getTicketDetail(mgmt, t.id)).id).toBe(t.id);
});

test("every transition is audited with its reason", async () => {
  const t = await createTicket(techMember, ask());
  await transitionTicket(logiHod, t.id, "REJECT", { reason: "no chairs left, ask Hospitality" });

  const detail = await getTicketDetail(techMember, t.id);
  const reject = detail.timeline.find((e) => e.action === "ticket.transition.REJECT");
  expect(reject?.reason).toBe("no chairs left, ask Hospitality");
  expect(reject?.actor).toBe("logi.hod@t.test");
});
