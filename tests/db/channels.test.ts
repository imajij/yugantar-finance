/**
 * Department channels and direct messages.
 *
 * The property this file exists to hold down is one sentence: **a channel's
 * audience is its membership rows.** Everything below is a way of trying to get at
 * a conversation without one — as another department's head, as the Finance HOD who
 * sees every rupee in the fest, as somebody who used to be in the department — and
 * being refused.
 *
 * The one exception is the administrator, and it is tested as an exception: they
 * read everything, they cannot post without joining, and the read is written to the
 * audit log where somebody can see who has been looking at what.
 */
import { afterAll, beforeEach, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, channelMembers, channels, messages } from "@/db/schema";
import type { SessionUser } from "@/lib/session";
import { dropFests } from "@/lib/test-support";
import { updateUser } from "@/lib/services/admin";
import {
  addMember, archiveChannel, backfillChannels, createChannel, deleteMessage, editMessage,
  getChannel, listChannels, listMessages, markRead, openDirect, postMessage, removeMember,
  unreadTotal,
} from "@/lib/services/chat";

const PREFIX = "chan-";
afterAll(() => dropFests(db, PREFIX));

let festId: string, techId: string, logiId: string, financeDeptId: string, coreId: string;
let techHod: SessionUser, techMember: SessionUser, logiHod: SessionUser, logiMember: SessionUser;
let finance: SessionUser, mgmt: SessionUser, admin: SessionUser;
let techChannel: string, logiChannel: string;

async function one<T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T> {
  return ((await db.execute(q)) as unknown as T[])[0];
}

const defaultChannelOf = async (departmentId: string) =>
  (await db.select({ id: channels.id }).from(channels)
    .where(and(eq(channels.departmentId, departmentId), eq(channels.isDefault, true))))[0].id;

beforeEach(async () => {
  festId = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end)
    values ('Channel Fest', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14')
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

  techHod = await mkUser("tech.hod@c.test", "DEPT_HOD", techId);
  techMember = await mkUser("tech.member@c.test", "MEMBER", techId);
  logiHod = await mkUser("logi.hod@c.test", "DEPT_HOD", logiId);
  logiMember = await mkUser("logi.member@c.test", "MEMBER", logiId);
  // A Finance HOD who is *not* an administrator: the role that sees every rupee,
  // to prove it does not therefore see every conversation.
  finance = await mkUser("finance@c.test", "FINANCE_HOD", financeDeptId);
  mgmt = await mkUser("mgmt@c.test", "MANAGEMENT", coreId);
  admin = await mkUser("admin@c.test", "MEMBER", coreId, true);

  await backfillChannels(techHod);
  techChannel = await defaultChannelOf(techId);
  logiChannel = await defaultChannelOf(logiId);
});

const say = (actor: SessionUser, channelId: string, body: string) =>
  postMessage(actor, channelId, { body });

/* ---------------------------------------------------------------- the wall */

test("every department gets a channel with its people in it", async () => {
  const detail = await getChannel(techHod, techChannel);
  expect(detail.name).toBe("general");
  expect(detail.isDefault).toBe(true);
  expect(detail.members.map((m) => m.email).sort())
    .toEqual([techHod.email, techMember.email].sort());
});

test("another department's head cannot read the channel, or even learn it exists", async () => {
  await say(techHod, techChannel, "Stage plan is in the drive");

  // Not "forbidden": saying a channel exists that you may not read is itself a
  // leak — it tells you which departments are talking about what.
  await expect(getChannel(logiHod, techChannel)).rejects.toThrow(/not found/i);
  await expect(listMessages(logiHod, techChannel)).rejects.toThrow(/not found/i);
  await expect(say(logiHod, techChannel, "hello")).rejects.toThrow(/not found/i);
});

test("a Member of another department is refused the same way", async () => {
  await expect(getChannel(logiMember, techChannel)).rejects.toThrow(/not found/i);
});

/**
 * The one that matters most. A Finance HOD reads every rupee in the fest and
 * approves every payment — and that is finance, not correspondence. Only the
 * administrator flag opens somebody else's channel.
 */
test("the Finance HOD sees every rupee and no conversation that is not theirs", async () => {
  await expect(getChannel(finance, techChannel)).rejects.toThrow(/not found/i);
  await expect(getChannel(mgmt, techChannel)).rejects.toThrow(/not found/i);

  const visible = await listChannels(finance);
  expect(visible.every((c) => c.isMember)).toBe(true);
  expect(visible.map((c) => c.id)).not.toContain(techChannel);
});

test("a department's own listing shows only its own channels", async () => {
  const mine = await listChannels(techMember);
  expect(mine).toHaveLength(1);
  expect(mine[0].id).toBe(techChannel);
});

/* ------------------------------------------------------------- the exception */

test("an administrator reads every channel, marked as not being in it", async () => {
  await say(techHod, techChannel, "Stage plan is in the drive");

  const detail = await getChannel(admin, techChannel);
  expect(detail.isMember).toBe(false);
  expect(detail.isOversight).toBe(true);
  // Told to everyone in the channel, not only to the administrator.
  expect(detail.administratorsCanRead).toBe(true);
  expect((await listMessages(admin, techChannel)).map((m) => m.body))
    .toEqual(["Stage plan is in the drive"]);

  const listed = await listChannels(admin);
  expect(listed.find((c) => c.id === techChannel)?.isMember).toBe(false);
  expect(listed.find((c) => c.id === logiChannel)).toBeTruthy();
});

test("an administrator cannot post in a channel they are not in", async () => {
  // Reading for oversight is not joining. Saying something means joining first,
  // which puts their name in the member list where everyone can see it.
  await expect(say(admin, techChannel, "I have been reading this"))
    .rejects.toThrow(/not permitted/i);
});

test("an administrator's read is written to the audit log", async () => {
  await getChannel(admin, techChannel);

  const [row] = await db.select().from(auditEvents).where(and(
    eq(auditEvents.festId, festId),
    eq(auditEvents.entityType, "CHANNEL"),
    eq(auditEvents.entityId, techChannel),
    eq(auditEvents.action, "channel.oversight_read"),
  ));
  expect(row).toBeTruthy();
  expect(row.actorId).toBe(admin.id);
});

test("a member's own read is not logged — only the looking-in kind is", async () => {
  await getChannel(techHod, techChannel);

  const rows = await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityId, techChannel),
    eq(auditEvents.action, "channel.oversight_read"),
  ));
  expect(rows).toHaveLength(0);
});

test("one visit is one audit row, not one per scroll", async () => {
  // Debounced deliberately: a row per page load makes the log unreadable, which
  // defeats the point of writing it.
  await getChannel(admin, techChannel);
  await getChannel(admin, techChannel);
  await getChannel(admin, techChannel);

  const rows = await db.select().from(auditEvents).where(and(
    eq(auditEvents.entityId, techChannel),
    eq(auditEvents.action, "channel.oversight_read"),
  ));
  expect(rows).toHaveLength(1);
});

/* ------------------------------------------------------- membership follows people */

test("an HOD can add their own people and nobody else's", async () => {
  const extra = await createChannel(techHod, { departmentId: techId, name: "stage-crew" });

  await expect(addMember(techHod, extra.id, logiMember.id))
    .rejects.toThrow(/people in this department/i);
  await expect(addMember(techHod, extra.id, techMember.id)).resolves.toBeTruthy();
});

test("an HOD cannot make a channel in another department", async () => {
  await expect(createChannel(techHod, { departmentId: logiId, name: "sneaky" }))
    .rejects.toThrow(/not permitted/i);
});

/**
 * The other half of the wall. Membership is the audience, so somebody moved out of
 * Tech who keeps their Tech membership row keeps reading Tech — quietly, with no
 * permission check anywhere that would notice.
 */
test("moving somebody between departments takes their channels with them", async () => {
  await say(techHod, techChannel, "Stage plan is in the drive");
  expect((await listMessages(techMember, techChannel))).toHaveLength(1);

  const financeAdmin = { ...finance, isSuperAdmin: true } as SessionUser;
  await updateUser(financeAdmin, techMember.id, { departmentId: logiId });

  const moved = { ...techMember, departmentId: logiId } as SessionUser;
  await expect(getChannel(moved, techChannel)).rejects.toThrow(/not found/i);
  await expect(getChannel(moved, logiChannel)).resolves.toBeTruthy();
});

test("deactivating somebody takes them out of every channel", async () => {
  const financeAdmin = { ...finance, isSuperAdmin: true } as SessionUser;
  await updateUser(financeAdmin, techMember.id, { status: "DISABLED" });

  const [rows] = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from channel_members where user_id = ${techMember.id}
  `)) as unknown as { n: number }[];
  expect(Number(rows.n)).toBe(0);
});

test("leaving is your own to do; removing anybody else is the HOD's", async () => {
  const extra = await createChannel(techHod, { departmentId: techId, name: "stage-crew" });
  await expect(removeMember(techMember, extra.id, techHod.id)).rejects.toThrow(/not permitted/i);
  await expect(removeMember(techMember, extra.id, techMember.id)).resolves.toBeTruthy();
});

test("nobody is removed from the default channel — it is where new people land", async () => {
  await expect(removeMember(techHod, techChannel, techMember.id))
    .rejects.toThrow(/everyone in the department/i);
  await expect(archiveChannel(techHod, techChannel)).rejects.toThrow(/cannot be archived/i);
});

/* ------------------------------------------------------------ direct messages */

test("a direct message opens once, however many times it is asked for", async () => {
  const a = await openDirect(techHod, logiHod.id);
  const b = await openDirect(logiHod, techHod.id);
  expect(b.id).toBe(a.id);

  const members = await db.select().from(channelMembers).where(eq(channelMembers.channelId, a.id));
  expect(members).toHaveLength(2);
});

test("a direct message is between its two people, and the administrator", async () => {
  const dm = await openDirect(techHod, logiHod.id);
  await say(techHod, dm.id, "Can your team spare a van on Friday?");

  expect((await listMessages(logiHod, dm.id))).toHaveLength(1);
  // Correspondence, and still not private from oversight — which is why the header
  // says so and the read is logged.
  expect((await listMessages(admin, dm.id))).toHaveLength(1);
  await expect(getChannel(techMember, dm.id)).rejects.toThrow(/not found/i);
  await expect(getChannel(finance, dm.id)).rejects.toThrow(/not found/i);
});

test("you cannot open a conversation with yourself", async () => {
  await expect(openDirect(techHod, techHod.id)).rejects.toThrow(/with yourself/i);
});

/* ------------------------------------------------------------------ messages */

test("a message needs to carry something", async () => {
  await expect(postMessage(techHod, techChannel, { body: "   " }))
    .rejects.toThrow(/say something/i);
});

test("replies go one level deep and join the thread", async () => {
  const top = await say(techHod, techChannel, "Who is driving on Friday?");
  const reply = await postMessage(techMember, techChannel, { body: "I can", parentId: top.id });
  const deeper = await postMessage(techHod, techChannel, { body: "Thanks", parentId: reply.id });

  // A reply to a reply belongs to the same thread rather than nesting again.
  expect(deeper.parentId).toBe(top.id);

  const topLevel = await listMessages(techHod, techChannel);
  expect(topLevel).toHaveLength(1);
  expect(topLevel[0].replyCount).toBe(2);
  expect(await listMessages(techHod, techChannel, { parentId: top.id })).toHaveLength(2);
});

test("only mentions of people in the channel notify", async () => {
  await postMessage(techHod, techChannel, {
    body: `@${techMember.email} and @${logiHod.email} — stage at four`,
  });

  const [row] = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from message_mentions
     where user_id = ${logiHod.id}
  `)) as unknown as { n: number }[];
  expect(Number(row.n)).toBe(0);

  const [mine] = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from message_mentions where user_id = ${techMember.id}
  `)) as unknown as { n: number }[];
  expect(Number(mine.n)).toBe(1);
});

test("a removed message keeps its place and says so", async () => {
  const m = await say(techMember, techChannel, "wrong channel, sorry");
  await deleteMessage(techMember, m.id);

  const [row] = await listMessages(techHod, techChannel);
  expect(row.deleted).toBe(true);
  expect(row.body).toBe("");
  // Soft, per 18.2 rule 7 — the row is still there.
  const [stored] = await db.select().from(messages).where(eq(messages.id, m.id));
  expect(stored.deletedAt).not.toBeNull();
});

test("the department's head can remove what was said in their channel; nobody else can", async () => {
  const m = await say(techMember, techChannel, "something regrettable");
  await expect(deleteMessage(logiHod, m.id)).rejects.toThrow(/not found/i);
  await expect(deleteMessage(techHod, m.id)).resolves.toBeTruthy();

  // Somebody else removing what you said is worth a permanent record.
  const [row] = await db.select().from(auditEvents).where(and(
    eq(auditEvents.festId, festId),
    eq(auditEvents.action, "channel.message.remove"),
  ));
  expect(row.actorId).toBe(techHod.id);
});

test("only the author edits, and only for five minutes", async () => {
  const m = await say(techMember, techChannel, "four o'clock");
  await expect(editMessage(techHod, m.id, "five o'clock")).rejects.toThrow(/only the author/i);
  await expect(editMessage(techMember, m.id, "five o'clock")).resolves.toBeTruthy();

  await db.execute(sql`
    update messages set created_at = now() - interval '10 minutes' where id = ${m.id}`);
  await expect(editMessage(techMember, m.id, "six o'clock"))
    .rejects.toThrow(/five minutes/i);
});

/* -------------------------------------------------------------------- unread */

test("unread counts what somebody else said since you last looked", async () => {
  expect(await unreadTotal(techMember)).toBe(0);

  await say(techHod, techChannel, "one");
  await say(techHod, techChannel, "two");
  expect(await unreadTotal(techMember)).toBe(2);

  await markRead(techMember, techChannel);
  expect(await unreadTotal(techMember)).toBe(0);

  // Your own message never makes your own channel look unread.
  await say(techMember, techChannel, "three");
  expect(await unreadTotal(techMember)).toBe(0);
});

test("an administrator's oversight read moves nobody's marker", async () => {
  await say(techHod, techChannel, "one");
  await markRead(admin, techChannel);
  expect(await unreadTotal(techMember)).toBe(1);
});

/* ------------------------------------------------------------- fest isolation */

test("a channel id from another fest is not found", async () => {
  const otherFest = (await one<{ id: string }>(sql`
    insert into fests (name, slug, starts_on, ends_on, receipt_window_start, receipt_window_end)
    values ('Other', ${PREFIX} || gen_random_uuid(), '2026-11-27','2026-11-29','2026-09-28','2026-12-14')
    returning id`)).id;
  const otherDept = (await one<{ id: string }>(sql`
    insert into departments (fest_id, name, slug, kind) values (${otherFest}, 'Tech', 'tech', 'BUDGET')
    returning id`)).id;
  const otherUser = (await one<{ id: string }>(sql`
    insert into users (fest_id, email, name, role, department_id, status)
    values (${otherFest}, 'x@c.test', 'x', 'DEPT_HOD', ${otherDept}, 'ACTIVE') returning id`)).id;
  const foreign = (await one<{ id: string }>(sql`
    insert into channels (fest_id, kind, department_id, name, is_default, created_by)
    values (${otherFest}, 'DEPARTMENT', ${otherDept}, 'general', true, ${otherUser}) returning id`)).id;

  // Even the administrator, whose reach is fest-wide and stops at the fest.
  await expect(getChannel(admin, foreign)).rejects.toThrow(/not found/i);
  await expect(getChannel(techHod, foreign)).rejects.toThrow(/not found/i);
});
