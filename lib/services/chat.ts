/**
 * Department channels and direct messages.
 *
 * One idea holds this file together: **a channel's audience is its membership rows.**
 * Every read and every write starts by resolving whether the caller is in the
 * channel, and hands that to `can()` as part of the resource — the same way a
 * reimbursement hands over its submitter. A department head cannot reach another
 * department's channel because they are not in it, not because a role check
 * somewhere said no. Role checks get forgotten at one call site out of twelve;
 * a missing membership row cannot be.
 *
 * The one exception is the administrator, who reads every channel. Two things make
 * that oversight rather than surveillance, and both are load-bearing:
 *
 *   - it is **disclosed** — the channel header says so to everyone in it;
 *   - it is **recorded** — opening a channel you are not in writes
 *     `channel.oversight_read` to the append-only audit log.
 *
 * Reading is all it is. Posting needs membership, so an administrator who wants to
 * say something joins first and appears in the member list like anybody else.
 */
import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  attachments, auditEvents, channelMembers, channels, departments,
  entityLinks, messageMentions, messages, users,
} from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, can, type Actor } from "@/lib/authz";
import { label as entityLabel, resolveEntity, VIEW_ACTION, type EntityType } from "@/lib/entities";
import type { SessionUser } from "@/lib/session";
import { asDate, asDateOrNull } from "@/lib/rows";
import { recordAudit } from "./audit";
import { notify } from "./notifications";

/** What a message may point at. Anything a person would say "is this done?" about. */
export type LinkableType = Extract<EntityType, "REIMBURSEMENT" | "VENDOR_REQUEST" | "TICKET" | "VENDOR">;
export const LINKABLE: LinkableType[] = ["REIMBURSEMENT", "VENDOR_REQUEST", "TICKET", "VENDOR"];

const MENTION = /@([a-z0-9._-]+@[a-z0-9.-]+)/gi;

/** PRD 20.10's rule for comments, applied here: correct a typo, don't rewrite an hour later. */
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * How long an administrator's oversight read stays "the same visit".
 *
 * Without this, scrolling a channel would write an audit row per page load and the
 * log would become unreadable — which defeats the point of writing it at all. One
 * row per administrator per channel per half hour is enough to answer "who has been
 * reading Logistics", which is the question it exists to answer.
 */
const OVERSIGHT_DEBOUNCE_MS = 30 * 60 * 1000;

/* -------------------------------------------------------------- resolving one */

export interface ResolvedChannel {
  id: string;
  festId: string;
  kind: "DEPARTMENT" | "DIRECT";
  departmentId: string | null;
  name: string | null;
  topic: string | null;
  isDefault: boolean;
  archivedAt: Date | null;
  /** True when the caller has a membership row. Decides everything below. */
  isMember: boolean;
  /** True when they are reading it *without* one — an administrator looking in. */
  isOversight: boolean;
}

/**
 * The channel, plus whether this caller is in it — the two facts every other
 * function here needs, fetched together so no caller can accidentally skip the
 * second one.
 */
async function resolve(
  actor: Actor, channelId: string, tx?: Tx,
): Promise<ResolvedChannel> {
  const runner = tx ?? db;
  const [row] = await runner.select({
    id: channels.id, festId: channels.festId, kind: channels.kind,
    departmentId: channels.departmentId, name: channels.name, topic: channels.topic,
    isDefault: channels.isDefault, archivedAt: channels.archivedAt,
    // A UUID is not a secret (18.2 rule 10), so `fest_id` is in the WHERE clause and
    // membership is looked up rather than assumed.
    member: sql<boolean>`exists (
      select 1 from channel_members m
       where m.channel_id = ${channels.id} and m.user_id = ${actor.id}
    )`.mapWith(Boolean),
  }).from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.festId, actor.festId)))
    .limit(1);

  if (!row) throw notFound("Channel");

  const resource = { festId: actor.festId, departmentId: row.departmentId ?? undefined, isChannelMember: row.member };
  if (!can(actor, "channel.view", resource)) {
    // Not "forbidden": telling somebody a channel exists that they may not read is
    // itself a leak — it says which departments are talking about what.
    throw notFound("Channel");
  }

  return {
    ...row,
    isMember: row.member,
    isOversight: !row.member && can(actor, "channel.oversee", { festId: actor.festId }),
  };
}

/** The resource `can()` needs for a channel this caller has already been resolved against. */
const asResource = (actor: Actor, channel: ResolvedChannel) => ({
  festId: actor.festId,
  departmentId: channel.departmentId ?? undefined,
  isChannelMember: channel.isMember,
});

/**
 * Writes `channel.oversight_read` when an administrator opens a channel they are
 * not in — debounced, so one visit is one row rather than one per scroll.
 */
async function recordOversight(actor: SessionUser, channel: ResolvedChannel): Promise<void> {
  if (!channel.isOversight) return;

  const since = new Date(Date.now() - OVERSIGHT_DEBOUNCE_MS);
  const [recent] = await db.select({ id: auditEvents.id }).from(auditEvents)
    .where(and(
      eq(auditEvents.entityType, "CHANNEL"),
      eq(auditEvents.entityId, channel.id),
      eq(auditEvents.actorId, actor.id),
      eq(auditEvents.action, "channel.oversight_read"),
      sql`${auditEvents.createdAt} > ${since.toISOString()}::timestamptz`,
    )).limit(1);
  if (recent) return;

  await db.transaction(async (tx) => {
    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: channel.id, actorId: actor.id,
      action: "channel.oversight_read",
      after: { channel: channel.name ?? "a direct message", kind: channel.kind },
      reason: "Administrator read a channel they are not a member of",
    });
  });
}

/* -------------------------------------------------------------------- listing */

export interface ChannelSummary {
  id: string;
  kind: "DEPARTMENT" | "DIRECT";
  name: string;
  topic: string | null;
  departmentId: string | null;
  departmentName: string | null;
  isDefault: boolean;
  isMember: boolean;
  archived: boolean;
  unread: number;
  mentions: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  memberCount: number;
}

/**
 * Every channel this caller may open: the ones they are in, plus — for an
 * administrator — every other one in the fest, marked as not-a-member so the UI can
 * say why they are seeing it.
 */
export async function listChannels(actor: SessionUser): Promise<ChannelSummary[]> {
  const oversees = can(actor, "channel.oversee", { festId: actor.festId });

  const rows = (await db.execute(sql`
    select c.id, c.kind::text as kind, c.name, c.topic, c.department_id, c.is_default,
           c.archived_at, d.name as department_name,
           (mine.user_id is not null) as is_member,
           (select count(*)::int from channel_members m where m.channel_id = c.id) as member_count,
           last.created_at as last_message_at,
           last.body        as last_message_preview,
           coalesce((
             select count(*)::int from messages m
              where m.channel_id = c.id and m.deleted_at is null
                and m.author_id <> ${actor.id}
                and (mine.last_read_at is null or m.created_at > mine.last_read_at)
           ), 0) as unread,
           coalesce((
             select count(*)::int from messages m
              join message_mentions mm on mm.message_id = m.id and mm.user_id = ${actor.id}
              where m.channel_id = c.id and m.deleted_at is null
                and (mine.last_read_at is null or m.created_at > mine.last_read_at)
           ), 0) as mentions,
           -- Direct messages are named after the other person, which the caller may
           -- only be told for their own conversations.
           (select u.name from channel_members om
              join users u on u.id = om.user_id
             where om.channel_id = c.id and om.user_id <> ${actor.id}
             limit 1) as other_name
      from channels c
      left join departments d on d.id = c.department_id
      left join channel_members mine on mine.channel_id = c.id and mine.user_id = ${actor.id}
      left join lateral (
        select m.body, m.created_at from messages m
         where m.channel_id = c.id and m.deleted_at is null
         order by m.created_at desc limit 1
      ) last on true
     where c.fest_id = ${actor.festId}
       ${oversees ? sql`` : sql`and mine.user_id is not null`}
     order by (mine.user_id is not null) desc,
              coalesce(last.created_at, c.created_at) desc
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind) as "DEPARTMENT" | "DIRECT",
    name: r.kind === "DIRECT" ? String(r.other_name ?? "Direct message") : String(r.name),
    topic: (r.topic as string) ?? null,
    departmentId: (r.department_id as string) ?? null,
    departmentName: (r.department_name as string) ?? null,
    isDefault: Boolean(r.is_default),
    isMember: Boolean(r.is_member),
    archived: r.archived_at !== null,
    unread: Number(r.unread),
    mentions: Number(r.mentions),
    lastMessageAt: asDateOrNull(r.last_message_at),
    lastMessagePreview: r.last_message_preview ? String(r.last_message_preview).slice(0, 120) : null,
    memberCount: Number(r.member_count),
  }));
}

/** The badge in the sidebar: unread messages across every channel you are in. */
export async function unreadTotal(actor: Actor): Promise<number> {
  const [{ n }] = (await db.execute<{ n: number }>(sql`
    select coalesce(sum(x.unread), 0)::int as n from (
      select count(*)::int as unread
        from channel_members cm
        join messages m on m.channel_id = cm.channel_id
       where cm.user_id = ${actor.id}
         and m.deleted_at is null
         and m.author_id <> ${actor.id}
         and (cm.last_read_at is null or m.created_at > cm.last_read_at)
       group by cm.channel_id
    ) x
  `)) as unknown as { n: number }[];
  return Number(n);
}

/* ------------------------------------------------------------------- opening */

export interface ChannelDetail extends ResolvedChannel {
  displayName: string;
  members: { id: string; name: string; email: string; role: string }[];
  /** Told to everyone in the channel, not just to administrators. */
  administratorsCanRead: boolean;
}

export async function getChannel(actor: SessionUser, channelId: string): Promise<ChannelDetail> {
  const channel = await resolve(actor, channelId);
  await recordOversight(actor, channel);

  const members = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role,
  }).from(channelMembers)
    .innerJoin(users, eq(users.id, channelMembers.userId))
    .where(eq(channelMembers.channelId, channelId))
    .orderBy(asc(users.name));

  const other = members.find((m) => m.id !== actor.id);
  return {
    ...channel,
    displayName: channel.kind === "DIRECT" ? (other?.name ?? "Direct message") : (channel.name ?? ""),
    members,
    administratorsCanRead: true,
  };
}

/* ------------------------------------------------------------------ creating */

/**
 * The channel a department gets on creation.
 *
 * Called when a department is made and again lazily, because a fest that existed
 * before this feature has departments with no channel and nobody should have to
 * notice that. Idempotent: the partial unique index on `is_default` is what makes
 * it safe to call from two places at once.
 */
export async function ensureDepartmentChannel(
  tx: Tx, festId: string, departmentId: string, createdBy: string,
): Promise<string> {
  const [existing] = await tx.select({ id: channels.id }).from(channels)
    .where(and(
      eq(channels.departmentId, departmentId),
      eq(channels.isDefault, true),
      isNull(channels.archivedAt),
    )).limit(1);
  if (existing) return existing.id;

  const [row] = await tx.insert(channels).values({
    festId, kind: "DEPARTMENT", departmentId, name: "general",
    topic: "Everything this department is working on.",
    isDefault: true, createdBy,
  }).returning({ id: channels.id });

  // Everyone active in the department, including whoever runs it.
  await syncDepartmentMembers(tx, row.id, departmentId);
  return row.id;
}

/** Membership of a department channel follows the department. */
async function syncDepartmentMembers(tx: Tx, channelId: string, departmentId: string): Promise<void> {
  await tx.execute(sql`
    insert into channel_members (channel_id, user_id)
    select ${channelId}, u.id from users u
     where u.department_id = ${departmentId} and u.status = 'ACTIVE'
    on conflict do nothing
  `);
}

/**
 * Puts one person in the right channels for the department they are now in.
 *
 * This is the other half of the wall. Membership is the audience, so somebody moved
 * from Tech to Logistics who keeps their Tech membership row keeps reading Tech —
 * quietly, with no permission check anywhere that would notice. So the move takes
 * their department memberships with it: out of every channel belonging to a
 * department that is no longer theirs, into the new one's default.
 *
 * Direct messages are untouched. They are correspondence between two people and
 * have nothing to do with which department either of them is in.
 */
export async function syncMembershipForUser(
  tx: Tx, festId: string, userId: string, departmentId: string,
): Promise<void> {
  await tx.execute(sql`
    delete from channel_members cm
     using channels c
     where cm.channel_id = c.id
       and cm.user_id = ${userId}
       and c.fest_id = ${festId}
       and c.kind = 'DEPARTMENT'
       and c.department_id <> ${departmentId}
  `);

  await tx.execute(sql`
    insert into channel_members (channel_id, user_id)
    select c.id, ${userId} from channels c
     where c.fest_id = ${festId}
       and c.department_id = ${departmentId}
       and c.is_default
       and c.archived_at is null
    on conflict do nothing
  `);
}

/** Somebody deactivated stops being in any channel; their messages stay. */
export async function removeFromAllChannels(tx: Tx, festId: string, userId: string): Promise<void> {
  await tx.execute(sql`
    delete from channel_members cm
     using channels c
     where cm.channel_id = c.id and cm.user_id = ${userId} and c.fest_id = ${festId}
  `);
}

export interface CreateChannelInput {
  departmentId: string;
  name: string;
  topic?: string | null;
}

export async function createChannel(actor: SessionUser, input: CreateChannelInput) {
  assertCan(actor, "channel.manage", { festId: actor.festId, departmentId: input.departmentId });

  const name = normalizeName(input.name);

  return db.transaction(async (tx) => {
    const [dept] = await tx.select({ id: departments.id, name: departments.name, festId: departments.festId })
      .from(departments).where(eq(departments.id, input.departmentId)).limit(1);
    // The department id came off a URL; `can()` compared it to the caller's own and
    // cannot tell whether it is this fest's (18.2 rule 10).
    if (!dept || dept.festId !== actor.festId) throw notFound("Department");

    const [clash] = await tx.select({ id: channels.id }).from(channels)
      .where(and(
        eq(channels.departmentId, dept.id),
        sql`lower(${channels.name}) = ${name}`,
        isNull(channels.archivedAt),
      )).limit(1);
    if (clash) throw conflict(`${dept.name} already has a #${name}`);

    const [row] = await tx.insert(channels).values({
      festId: actor.festId, kind: "DEPARTMENT", departmentId: dept.id,
      name, topic: input.topic?.trim() || null, createdBy: actor.id,
    }).returning();

    await syncDepartmentMembers(tx, row.id, dept.id);

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: row.id, actorId: actor.id,
      action: "channel.create", after: { name: row.name, department: dept.name },
    });
    return row;
  });
}

/**
 * Opens the conversation between two people, or finds the one that already exists.
 *
 * The pair is keyed on both ids sorted, so "A messages B" and "B messages A" are the
 * same row — the unique index is what enforces that rather than a read-then-write
 * that two clicks could race past.
 */
export async function openDirect(actor: SessionUser, otherUserId: string) {
  if (otherUserId === actor.id) {
    throw new ApiError("VALIDATION_ERROR", "You cannot open a conversation with yourself");
  }

  return db.transaction(async (tx) => {
    const [other] = await tx.select({ id: users.id, name: users.name, festId: users.festId, status: users.status })
      .from(users).where(eq(users.id, otherUserId)).limit(1);
    if (!other || other.festId !== actor.festId || other.status !== "ACTIVE") throw notFound("Person");

    const key = [actor.id, other.id].sort().join(":");

    const [existing] = await tx.select().from(channels)
      .where(and(eq(channels.festId, actor.festId), eq(channels.directKey, key))).limit(1);
    if (existing) return existing;

    const [row] = await tx.insert(channels).values({
      festId: actor.festId, kind: "DIRECT", directKey: key, createdBy: actor.id,
    }).returning();

    await tx.insert(channelMembers)
      .values([{ channelId: row.id, userId: actor.id }, { channelId: row.id, userId: other.id }])
      .onConflictDoNothing();

    // A direct message is correspondence, and administrators can read it. Recording
    // the moment it opened is the least the audit log should carry about that.
    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: row.id, actorId: actor.id,
      action: "channel.direct.open", after: { with: other.name },
    });
    return row;
  });
}

export async function updateChannel(
  actor: SessionUser, channelId: string, input: { name?: string; topic?: string | null },
) {
  return db.transaction(async (tx) => {
    const channel = await resolve(actor, channelId, tx);
    assertManageable(actor, channel);

    if (input.name !== undefined && channel.isDefault) {
      throw new ApiError("VALIDATION_ERROR", "The default channel keeps its name — it is where new people land");
    }

    const [after] = await tx.update(channels).set({
      ...(input.name !== undefined ? { name: normalizeName(input.name) } : {}),
      ...(input.topic !== undefined ? { topic: input.topic?.trim() || null } : {}),
      updatedAt: new Date(),
    }).where(eq(channels.id, channelId)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: channelId, actorId: actor.id,
      action: "channel.update",
      before: { name: channel.name, topic: channel.topic },
      after: { name: after.name, topic: after.topic },
    });
    return after;
  });
}

/** Archiving, not deleting: the messages stay readable, nothing new can be said. */
export async function archiveChannel(actor: SessionUser, channelId: string) {
  return db.transaction(async (tx) => {
    const channel = await resolve(actor, channelId, tx);
    assertManageable(actor, channel);
    if (channel.isDefault) {
      throw new ApiError("VALIDATION_ERROR", "A department's default channel cannot be archived");
    }

    const [after] = await tx.update(channels)
      .set({ archivedAt: new Date(), archivedBy: actor.id, updatedAt: new Date() })
      .where(eq(channels.id, channelId)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: channelId, actorId: actor.id,
      action: "channel.archive", before: { name: channel.name, archived_at: null },
      after: { archived_at: after.archivedAt },
    });
    return after;
  });
}

function assertManageable(actor: Actor, channel: ResolvedChannel): void {
  if (channel.kind === "DIRECT") {
    throw new ApiError("VALIDATION_ERROR", "A direct message has no settings to change");
  }
  assertCan(actor, "channel.manage", { festId: actor.festId, departmentId: channel.departmentId ?? undefined });
}

function normalizeName(raw: string): string {
  const name = raw.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (name.length < 2 || name.length > 32) {
    throw new ApiError("VALIDATION_ERROR", "A channel name is 2–32 characters: letters, numbers and dashes");
  }
  return name;
}

/* ------------------------------------------------------------------ members */

/**
 * Adding somebody to a department channel.
 *
 * They have to already be in the department. This is the wall the whole feature
 * rests on: if an HOD could add anyone in the fest, "no other department can see
 * this" would be one careless click away from false.
 */
export async function addMember(actor: SessionUser, channelId: string, userId: string) {
  return db.transaction(async (tx) => {
    const channel = await resolve(actor, channelId, tx);
    assertManageable(actor, channel);

    const [person] = await tx.select({ id: users.id, name: users.name, departmentId: users.departmentId, festId: users.festId, status: users.status })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (!person || person.festId !== actor.festId) throw notFound("Person");
    if (person.status !== "ACTIVE") {
      throw new ApiError("VALIDATION_ERROR", "That account is not active");
    }
    if (person.departmentId !== channel.departmentId) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Only people in this department can be added — that is what keeps the channel the department's",
      );
    }

    await tx.insert(channelMembers).values({ channelId, userId }).onConflictDoNothing();
    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: channelId, actorId: actor.id,
      action: "channel.member.add", after: { user: person.name },
    });
    return { ok: true };
  });
}

export async function removeMember(actor: SessionUser, channelId: string, userId: string) {
  return db.transaction(async (tx) => {
    const channel = await resolve(actor, channelId, tx);
    // Leaving is your own to do; removing somebody else is managing the channel.
    if (userId !== actor.id) assertManageable(actor, channel);
    if (channel.kind === "DIRECT") {
      throw new ApiError("VALIDATION_ERROR", "A direct message has two people and keeps them");
    }
    if (channel.isDefault && userId !== actor.id) {
      throw new ApiError("VALIDATION_ERROR", "Everyone in the department is in its default channel");
    }

    await tx.delete(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CHANNEL", entityId: channelId, actorId: actor.id,
      action: userId === actor.id ? "channel.member.leave" : "channel.member.remove",
      before: { user_id: userId },
    });
    return { ok: true };
  });
}

/** Who an HOD could still add — their department, minus whoever is already in. */
export async function addableMembers(actor: SessionUser, channelId: string) {
  const channel = await resolve(actor, channelId);
  if (channel.kind === "DIRECT" || !channel.departmentId) return [];
  if (!can(actor, "channel.manage", { festId: actor.festId, departmentId: channel.departmentId })) return [];

  return db.select({ id: users.id, name: users.name, email: users.email }).from(users)
    .where(and(
      eq(users.departmentId, channel.departmentId),
      eq(users.status, "ACTIVE"),
      sql`not exists (select 1 from channel_members m
                       where m.channel_id = ${channelId} and m.user_id = ${users.id})`,
    ))
    .orderBy(asc(users.name));
}

/* ----------------------------------------------------------------- messages */

export interface MessageRow {
  id: string;
  body: string;
  authorId: string;
  author: string;
  createdAt: Date;
  editedAt: Date | null;
  deleted: boolean;
  parentId: string | null;
  replyCount: number;
  lastReplyAt: Date | null;
  attachments: { id: string; fileName: string | null; mimeType: string | null; sizeBytes: number | null }[];
  links: { type: string; id: string; humanId: string | null; label: string; status: string | null }[];
  mentionsMe: boolean;
}

export interface MessageQuery {
  /** Messages newer than this timestamp — how the open window polls for new ones. */
  after?: string;
  /** Messages older than this — how scrolling back works. */
  before?: string;
  /** The replies to one message rather than the channel's top level. */
  parentId?: string;
  limit?: number;
}

export async function listMessages(
  actor: SessionUser, channelId: string, q: MessageQuery = {},
): Promise<MessageRow[]> {
  await resolve(actor, channelId);

  const rows = (await db.execute(sql`
    select m.id, m.body, m.author_id, u.name as author, m.created_at, m.edited_at,
           m.deleted_at, m.parent_id,
           (select count(*)::int from messages r
             where r.parent_id = m.id and r.deleted_at is null) as reply_count,
           (select max(r.created_at) from messages r
             where r.parent_id = m.id and r.deleted_at is null) as last_reply_at,
           exists (select 1 from message_mentions mm
                    where mm.message_id = m.id and mm.user_id = ${actor.id}) as mentions_me,
           coalesce((
             select json_agg(json_build_object(
                      'id', a.id, 'fileName', a.file_name,
                      'mimeType', a.mime_type, 'sizeBytes', a.size_bytes) order by a.created_at)
               from attachments a
              where a.entity_type = 'MESSAGE' and a.entity_id = m.id and a.removed_at is null
           ), '[]'::json) as attachments,
           coalesce((
             select json_agg(json_build_object('type', l.to_type, 'id', l.to_id) order by l.created_at)
               from entity_links l
              where l.from_type = 'MESSAGE' and l.from_id = m.id
           ), '[]'::json) as links
      from messages m
      join users u on u.id = m.author_id
     where m.channel_id = ${channelId}
       ${q.parentId ? sql`and m.parent_id = ${q.parentId}` : sql`and m.parent_id is null`}
       ${q.after ? sql`and m.created_at > ${q.after}::timestamptz` : sql``}
       ${q.before ? sql`and m.created_at < ${q.before}::timestamptz` : sql``}
     order by m.created_at ${q.before ? sql`desc` : sql`asc`}
     limit ${Math.min(q.limit ?? 100, 200)}
  `)) as unknown as Record<string, unknown>[];

  const ordered = q.before ? rows.reverse() : rows;
  const decorated = await decorateLinks(actor, ordered);

  return decorated.map((r) => ({
    id: String(r.id),
    // A removed message keeps its place in the conversation and says so, rather than
    // leaving a gap that reads as somebody being edited out.
    body: r.deleted_at ? "" : String(r.body),
    authorId: String(r.author_id),
    author: String(r.author),
    createdAt: asDate(r.created_at),
    editedAt: asDateOrNull(r.edited_at),
    deleted: r.deleted_at !== null,
    parentId: (r.parent_id as string) ?? null,
    replyCount: Number(r.reply_count),
    lastReplyAt: asDateOrNull(r.last_reply_at),
    attachments: r.deleted_at ? [] : (r.attachments as MessageRow["attachments"]),
    links: r.deleted_at ? [] : (r.resolvedLinks as MessageRow["links"]),
    mentionsMe: Boolean(r.mentions_me),
  }));
}

/**
 * Turns the linked ids into something readable — YUG-142, its status, its amount.
 *
 * Each is resolved through `resolveEntity` and checked with `can()`, because a link
 * in a channel must not become a way to read a record you could not otherwise open:
 * a Member of Logistics seeing "REIMB-88 · ₹4,200 · approved" in a channel would be
 * a leak dressed up as a convenience. What they cannot see renders as a plain
 * "a reimbursement you cannot open".
 */
async function decorateLinks(
  actor: SessionUser, rows: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const wanted = rows.flatMap((r) => (r.links as { type: string; id: string }[]) ?? []);
  if (wanted.length === 0) return rows.map((r) => ({ ...r, resolvedLinks: [] }));

  const seen = new Map<string, MessageRow["links"][number]>();
  for (const link of wanted) {
    const key = `${link.type}:${link.id}`;
    if (seen.has(key)) continue;

    let entry: MessageRow["links"][number];
    try {
      const resource = await resolveEntity(actor.festId, link.type as EntityType, link.id);
      entry = can(actor, VIEW_ACTION[link.type as EntityType], resource)
        ? {
            type: link.type, id: link.id,
            humanId: resource.humanId ?? null,
            label: resource.humanId ?? entityLabel(link.type as EntityType),
            status: resource.status ?? null,
          }
        : { type: link.type, id: link.id, humanId: null, label: `a ${entityLabel(link.type as EntityType)} you cannot open`, status: null };
    } catch {
      entry = { type: link.type, id: link.id, humanId: null, label: "a record that no longer exists", status: null };
    }
    seen.set(key, entry);
  }

  return rows.map((r) => ({
    ...r,
    resolvedLinks: ((r.links as { type: string; id: string }[]) ?? [])
      .map((l) => seen.get(`${l.type}:${l.id}`))
      .filter(Boolean),
  }));
}

export interface PostMessageInput {
  body: string;
  parentId?: string | null;
  attachmentIds?: string[];
  links?: { type: LinkableType; id: string }[];
}

export async function postMessage(actor: SessionUser, channelId: string, input: PostMessageInput) {
  const body = input.body.trim();
  const hasPayload = body.length > 0 || (input.attachmentIds?.length ?? 0) > 0 || (input.links?.length ?? 0) > 0;
  if (!hasPayload) throw new ApiError("VALIDATION_ERROR", "Say something, attach something, or link something");
  if (body.length > 4000) throw new ApiError("VALIDATION_ERROR", "A message is at most 4000 characters");

  return db.transaction(async (tx) => {
    const channel = await resolve(actor, channelId, tx);
    // Reading a channel for oversight is not joining it (see the file header).
    assertCan(actor, "channel.post", asResource(actor, channel));
    if (channel.archivedAt) throw new ApiError("VALIDATION_ERROR", "That channel is archived");

    let parentId: string | null = null;
    if (input.parentId) {
      const [parent] = await tx.select({ id: messages.id, parentId: messages.parentId })
        .from(messages)
        .where(and(eq(messages.id, input.parentId), eq(messages.channelId, channelId)))
        .limit(1);
      if (!parent) throw notFound("Message");
      // One level: replying to a reply joins that thread rather than nesting again.
      parentId = parent.parentId ?? parent.id;
    }

    const [row] = await tx.insert(messages).values({
      festId: actor.festId, channelId, authorId: actor.id, body, parentId,
    }).returning();

    if (input.attachmentIds?.length) await bindAttachments(tx, actor, row.id, input.attachmentIds);
    if (input.links?.length) await bindLinks(tx, actor, row.id, input.links);

    const mentioned = await recordMentions(tx, actor, channelId, row.id, body);

    // The unread count is "since I last read", so the author's own message must not
    // make their own channel look unread.
    await tx.update(channelMembers).set({ lastReadAt: row.createdAt })
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actor.id)));

    if (mentioned.length) {
      await notify(tx, {
        festId: actor.festId,
        type: "channel.mention",
        title: `${actor.name} mentioned you in ${channel.kind === "DIRECT" ? "a message" : `#${channel.name}`}`,
        body: body.slice(0, 200),
        entityType: "FEST",
        toUsers: mentioned,
        inAppOnly: true,
        footnote: "Open the channel to reply.",
      });
    }

    return { ...row, author: actor.name };
  });
}

/** Only people in the channel can be mentioned — a mention is a notification. */
async function recordMentions(
  tx: Tx, actor: Actor, channelId: string, messageId: string, body: string,
): Promise<string[]> {
  const emails = [...body.matchAll(MENTION)].map((m) => m[1].toLowerCase());
  if (emails.length === 0) return [];

  const found = await tx.select({ id: users.id }).from(users)
    .innerJoin(channelMembers, and(
      eq(channelMembers.userId, users.id),
      eq(channelMembers.channelId, channelId),
    ))
    .where(and(eq(users.festId, actor.festId), inArray(sql`lower(${users.email})`, emails)));

  const ids = found.map((u) => u.id).filter((id) => id !== actor.id);
  if (ids.length) {
    await tx.insert(messageMentions)
      .values(ids.map((userId) => ({ messageId, userId })))
      .onConflictDoNothing();
  }
  return ids;
}

async function bindAttachments(tx: Tx, actor: Actor, messageId: string, ids: string[]): Promise<void> {
  if (ids.length > 5) throw new ApiError("VALIDATION_ERROR", "At most five files on a message");

  for (const attachmentId of ids) {
    const bound = await tx.update(attachments)
      .set({ entityType: "MESSAGE", entityId: messageId })
      .where(and(
        eq(attachments.id, attachmentId),
        eq(attachments.festId, actor.festId),
        // Only your own uploads, and only ones not already bound (20.2 step 4).
        eq(attachments.uploadedBy, actor.id),
        isNull(attachments.entityId),
        isNull(attachments.removedAt),
      ))
      .returning({ id: attachments.id });
    if (bound.length === 0) {
      throw new ApiError("VALIDATION_ERROR", "That upload was already used, removed, or is not yours");
    }
  }
}

/**
 * Linking a record into a message.
 *
 * You may only link what you can already see — otherwise a link becomes a way of
 * asking somebody else to look something up for you, and the ids in a channel start
 * mapping the fest for whoever is in it.
 */
async function bindLinks(
  tx: Tx, actor: SessionUser, messageId: string, links: { type: LinkableType; id: string }[],
): Promise<void> {
  if (links.length > 5) throw new ApiError("VALIDATION_ERROR", "At most five linked records on a message");

  for (const link of links) {
    if (!LINKABLE.includes(link.type)) {
      throw new ApiError("VALIDATION_ERROR", `${link.type} cannot be linked into a message`);
    }
    const resource = await resolveEntity(actor.festId, link.type, link.id, tx);
    if (!can(actor, VIEW_ACTION[link.type], resource)) {
      throw new ApiError("FORBIDDEN", "You cannot link a record you cannot open");
    }
    await tx.insert(entityLinks).values({
      festId: actor.festId,
      fromType: "MESSAGE", fromId: messageId,
      toType: link.type, toId: link.id,
      relation: "MENTIONED_IN", createdBy: actor.id,
    }).onConflictDoNothing();
  }
}

export async function editMessage(actor: SessionUser, messageId: string, body: string) {
  const trimmed = body.trim();
  if (!trimmed) throw new ApiError("VALIDATION_ERROR", "An edited message still needs to say something");

  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.festId, actor.festId))).limit(1);
    if (!row) throw notFound("Message");
    await resolve(actor, row.channelId, tx);

    if (row.authorId !== actor.id) {
      throw new ApiError("FORBIDDEN", "Only the author can edit a message");
    }
    if (row.deletedAt) throw new ApiError("VALIDATION_ERROR", "That message was removed");
    // 20.10's rule for comments: correct a typo, don't rewrite an hour later.
    if (Date.now() - row.createdAt.getTime() > EDIT_WINDOW_MS) {
      throw new ApiError("VALIDATION_ERROR", "A message can only be edited for five minutes; post a correction instead");
    }

    const [after] = await tx.update(messages)
      .set({ body: trimmed, editedAt: new Date() })
      .where(eq(messages.id, messageId)).returning();
    return after;
  });
}

/**
 * Removing a message. Soft (18.2 rule 7), and the row keeps its place in the
 * conversation showing as removed — a gap reads as somebody being edited out.
 *
 * The author removes their own; a department's head removes anything in their own
 * channels, because moderating what is said in their department is theirs.
 */
export async function deleteMessage(actor: SessionUser, messageId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.festId, actor.festId))).limit(1);
    if (!row) throw notFound("Message");
    const channel = await resolve(actor, row.channelId, tx);

    const isAuthor = row.authorId === actor.id;
    const moderates = channel.kind === "DEPARTMENT"
      && can(actor, "channel.manage", { festId: actor.festId, departmentId: channel.departmentId ?? undefined });
    if (!isAuthor && !moderates) {
      throw new ApiError("FORBIDDEN", "Only the author or the department's head can remove a message");
    }
    if (row.deletedAt) return { ok: true };

    await tx.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, messageId));

    // Somebody else removing what you said is worth a permanent record.
    if (!isAuthor) {
      await recordAudit(tx, {
        festId: actor.festId, entityType: "CHANNEL", entityId: channel.id, actorId: actor.id,
        action: "channel.message.remove",
        before: { message_id: messageId, author_id: row.authorId },
      });
    }
    return { ok: true };
  });
}

/** Marks the channel read up to now. Oversight reads never move anybody's marker. */
export async function markRead(actor: SessionUser, channelId: string) {
  const channel = await resolve(actor, channelId);
  if (!channel.isMember) return { ok: true };

  await db.update(channelMembers)
    .set({ lastReadAt: new Date() })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, actor.id)));
  return { ok: true };
}

/* -------------------------------------------------------------- backfilling */

/**
 * Gives every department that has no default channel one, and puts its people in.
 *
 * A fest created before this feature existed has departments with no channel, and
 * a person opening the page should not have to know that. Run on the chat page's
 * first load and by the seed.
 */
export async function backfillChannels(actor: Actor): Promise<number> {
  const missing = await db.select({ id: departments.id }).from(departments)
    .where(and(
      eq(departments.festId, actor.festId),
      eq(departments.isActive, true),
      sql`not exists (select 1 from channels c
                       where c.department_id = ${departments.id}
                         and c.is_default and c.archived_at is null)`,
    ));

  if (missing.length > 0) {
    await db.transaction(async (tx) => {
      for (const dept of missing) {
        await ensureDepartmentChannel(tx, actor.festId, dept.id, actor.id);
      }
    });
  }

  // Always, not only when a channel was missing. A department can have had its
  // channel since the day it was made and still gain people afterwards — and the
  // early return that skipped this was invisible: everything answered 200 and the
  // person simply had no channels.
  await db.execute(sql`
    insert into channel_members (channel_id, user_id)
    select c.id, u.id
      from channels c
      join users u on u.department_id = c.department_id and u.status = 'ACTIVE'
     where c.fest_id = ${actor.festId} and c.is_default and c.archived_at is null
    on conflict do nothing
  `);

  return missing.length;
}

/** People you could start a conversation with: everyone active but you. */
export async function directCandidates(actor: Actor) {
  return db.select({
    id: users.id, name: users.name, email: users.email,
    role: users.role, department: departments.name,
  }).from(users)
    .innerJoin(departments, eq(departments.id, users.departmentId))
    .where(and(
      eq(users.festId, actor.festId),
      eq(users.status, "ACTIVE"),
      ne(users.id, actor.id),
    ))
    .orderBy(asc(departments.name), asc(users.name));
}

/** The administrator's view of who has been reading what — 20.11's log, filtered. */
export async function oversightReads(actor: Actor, limit = 50) {
  assertCan(actor, "channel.oversee", { festId: actor.festId });
  return (await db.select({
    id: auditEvents.id, createdAt: auditEvents.createdAt,
    actor: users.name, after: auditEvents.after, channelId: auditEvents.entityId,
  }).from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(and(
      eq(auditEvents.festId, actor.festId),
      eq(auditEvents.entityType, "CHANNEL"),
      eq(auditEvents.action, "channel.oversight_read"),
    ))
    .orderBy(desc(auditEvents.createdAt))
    .limit(limit));
}

/**
 * Whether this caller may see a message — and therefore the files hanging off it.
 *
 * Exported because a chat attachment's visibility cannot be expressed as a
 * `Resource`: it depends on a membership row and the caller's own id, not on a
 * department or a submitter. `lib/services/attachments.ts` asks here rather than
 * guessing, which keeps one answer to "who can see this message" instead of two.
 */
export async function canSeeMessage(actor: Actor, messageId: string): Promise<boolean> {
  const [row] = await db.select({ channelId: messages.channelId }).from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.festId, actor.festId))).limit(1);
  if (!row) return false;
  try {
    await resolve(actor, row.channelId);
    return true;
  } catch {
    return false;
  }
}

/** Whether they may attach *to* it, which is narrower: their own message, unsent files aside. */
export async function canAttachToMessage(actor: Actor, messageId: string): Promise<boolean> {
  const [row] = await db.select({ authorId: messages.authorId }).from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.festId, actor.festId))).limit(1);
  return row?.authorId === actor.id;
}
