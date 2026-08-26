/**
 * A department head managing their own team (PRD 5.1, 18.2 rule 6).
 *
 * One sentence holds this file together: **a head may add and remove the members of
 * their own department, and may do nothing else to anybody.** Every test below is a
 * way of trying to turn that narrow power into a wider one — appointing a second
 * head, promoting a member, taking somebody out of another department, editing
 * one's own row — and being refused.
 *
 * The reason the line sits exactly here is 5.2. A head who could appoint another
 * head could appoint the person who endorses their own claims, and segregation of
 * duties would be undone from the inside without a single rule changing.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { channelMembers, users } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import { inviteUser, listUsers, updateUser } from "@/lib/services/admin";
import { backfillChannels } from "@/lib/services/chat";

const PREFIX = "team-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string, coreId: string;
let techHod: SessionUser, techMember: SessionUser, logiHod: SessionUser, logiMember: SessionUser;
let finance: SessionUser, admin: SessionUser;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

const emailOf = (n: number) => `new-${n}@sst.scaler.com`;

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end)
    values ('Team Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14')
    returning id`)).id;

  const mkDept = async (name: string, slug: string, kind: string) =>
    (await one<{ id: string }>(sql`
      insert into departments (fest_id, name, slug, kind) values
      (${festId}, ${name}, ${slug}, ${sql.raw(`'${kind}'::department_kind`)}) returning id`)).id;

  financeDeptId = await mkDept("Finance", "finance", "FINANCE");
  coreId = await mkDept("Core", "core", "CORE");
  techId = await mkDept("Tech", "tech", "BUDGET");
  logiId = await mkDept("Logistics", "logistics", "BUDGET");

  const mkUser = async (email: string, role: SessionUser["role"], deptId: string, superAdmin = false) => ({
    id: (await one<{ id: string }>(sql`
      insert into users (fest_id, email, name, role, department_id, status, is_super_admin)
      values (${festId}, ${email}, ${email}, ${sql.raw(`'${role}'::user_role`)}, ${deptId}, 'ACTIVE', ${superAdmin})
      returning id`)).id,
    festId, role, departmentId: deptId, name: email, email,
    departmentName: deptId, departmentKind: "BUDGET", status: "ACTIVE", upiId: null,
    isSuperAdmin: superAdmin,
  } as SessionUser);

  techHod = await mkUser("tech.hod@t.test", "DEPT_HOD", techId);
  techMember = await mkUser("tech.member@t.test", "MEMBER", techId);
  logiHod = await mkUser("logi.hod@t.test", "DEPT_HOD", logiId);
  logiMember = await mkUser("logi.member@t.test", "MEMBER", logiId);
  finance = await mkUser("finance@t.test", "FINANCE_HOD", financeDeptId);
  admin = await mkUser("admin@t.test", "MEMBER", coreId, true);

  await backfillChannels(techHod);
});

/* ------------------------------------------------------------ what they may do */

test("a head adds a member to their own department, and the channel follows", async () => {
  const created = await inviteUser(techHod, {
    name: "New Hand", email: emailOf(1), role: "MEMBER", departmentId: techId,
  });

  const [row] = await db.select().from(users).where(eq(users.id, created.id));
  expect(row.role).toBe("MEMBER");
  expect(row.departmentId).toBe(techId);
  expect(row.status).toBe("INVITED");

  // Nobody had to add them to the conversation: membership follows the department.
  const memberships = await db.select().from(channelMembers).where(eq(channelMembers.userId, created.id));
  expect(memberships.length).toBeGreaterThan(0);
});

test("a head removes a member by deactivating them, and the channel follows", async () => {
  await updateUser(techHod, techMember.id, { status: "DISABLED" });

  const [row] = await db.select().from(users).where(eq(users.id, techMember.id));
  expect(row.status).toBe("DISABLED");
  // Removed rather than muted: a disabled account should not be sitting in a
  // channel roster looking like somebody who is still reading it.
  expect(await db.select().from(channelMembers).where(eq(channelMembers.userId, techMember.id))).toEqual([]);
});

test("a head sees their own team and nobody else's", async () => {
  const seen = await listUsers(techHod);
  expect(seen.map((u) => u.email).sort()).toEqual([techHod.email, techMember.email].sort());

  // Finance asks the same question and gets the fest.
  const all = await listUsers(finance);
  expect(all.length).toBeGreaterThan(seen.length);
  expect(all.map((u) => u.email)).toContain(logiMember.email);
});

/* --------------------------------------------------------- what they may not do */

test("a head cannot appoint another head — 5.2 would be undone from the inside", async () => {
  await expect(inviteUser(techHod, {
    name: "Shadow", email: emailOf(2), role: "DEPT_HOD", departmentId: techId,
  })).rejects.toThrow(/roles are finance's/i);

  await expect(inviteUser(techHod, {
    name: "Shadow", email: emailOf(3), role: "FINANCE_HOD", departmentId: techId,
  })).rejects.toThrow(/roles are finance's/i);
});

test("a head cannot promote one of their own members", async () => {
  await expect(updateUser(techHod, techMember.id, { role: "DEPT_HOD" }))
    .rejects.toThrow(/role is finance's/i);
});

test("a head cannot reach into another department", async () => {
  // Adding to it…
  await expect(inviteUser(techHod, {
    name: "Poach", email: emailOf(4), role: "MEMBER", departmentId: logiId,
  })).rejects.toThrow(/not permitted/i);

  // …editing somebody in it…
  await expect(updateUser(techHod, logiMember.id, { status: "DISABLED" }))
    .rejects.toThrow(/not permitted/i);

  // …or taking them out of it.
  await expect(updateUser(techHod, techMember.id, { departmentId: logiId }))
    .rejects.toThrow(/departments is finance's/i);
});

test("a head cannot touch the other department's head, even to deactivate them", async () => {
  await expect(updateUser(techHod, logiHod.id, { status: "DISABLED" }))
    .rejects.toThrow(/not permitted|department head/i);
});

test("a head cannot edit their own account", async () => {
  await expect(updateUser(techHod, techHod.id, { status: "DISABLED" }))
    .rejects.toThrow(/your own account/i);
});

test("a head cannot appoint an administrator", async () => {
  await expect(inviteUser(techHod, {
    name: "Watcher", email: emailOf(5), role: "MEMBER", departmentId: techId, isSuperAdmin: true,
  })).rejects.toThrow(/administrator/i);

  await expect(updateUser(techHod, techMember.id, { isSuperAdmin: true }))
    .rejects.toThrow(/administrator/i);
});

/**
 * The administrator flag is oversight, not authority. It opens every ledger and
 * every conversation for reading; it does not put people in departments.
 */
test("an administrator who is not Finance still cannot manage people", async () => {
  await expect(listUsers(admin)).rejects.toThrow(/not permitted/i);
  await expect(inviteUser(admin, {
    name: "Hire", email: emailOf(6), role: "MEMBER", departmentId: techId,
  })).rejects.toThrow(/not permitted/i);
});

test("a Member has none of this", async () => {
  await expect(listUsers(techMember)).rejects.toThrow(/not permitted/i);
  await expect(updateUser(techMember, techHod.id, { status: "DISABLED" }))
    .rejects.toThrow(/not permitted/i);
});

/* ------------------------------------------------------ Finance keeps the wide door */

test("Finance still does everything a head cannot", async () => {
  await updateUser(finance, techMember.id, { role: "DEPT_HOD", departmentId: logiId });
  const [row] = await db.select().from(users).where(eq(users.id, techMember.id));
  expect(row.role).toBe("DEPT_HOD");
  expect(row.departmentId).toBe(logiId);
});
