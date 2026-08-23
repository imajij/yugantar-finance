/**
 * In-app notifications and the email outbox (PRD 10, 11).
 *
 * `notify()` writes one IN_APP row per recipient and — unless the caller opts out —
 * one EMAIL row alongside it, all inside the caller's transaction. Nothing is sent
 * from inside the transaction: a slow or failing mail provider must never hold a
 * database write open or roll one back. `flushOutbox()` sends the unsent EMAIL rows
 * afterwards, and anything it fails to send stays unsent for the next sweep.
 */
import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { notifications, users } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { sendEmail, type EmailMessage } from "@/lib/email";
import { formatPaise } from "@/lib/money";

export type NotifyEntity =
  | "REIMBURSEMENT" | "VENDOR_REQUEST" | "TICKET" | "LINE_ITEM"
  | "INCOME_ENTRY" | "DEPARTMENT" | "VENDOR" | "FEST";

export interface NotifyInput {
  festId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: NotifyEntity;
  entityId?: string;
  toUsers?: string[];
  toDepartmentHods?: string[];
  /** Every active member of these departments — Urgent tickets do this (PRD 10). */
  toDepartmentMembers?: string[];
  toRoles?: ("FINANCE_HOD" | "MANAGEMENT" | "DEPT_HOD")[];
  /** Facts worth putting in the email body: amount, due date, who is next. */
  blocks?: { label: string; value: string }[];
  footnote?: string;
  /** In-app only. Used for chatty events that would make email unbearable. */
  inAppOnly?: boolean;
  /** Never notify the person who caused the event. */
  exceptUserId?: string;
}

/** Where an email's button should land. Keep in step with the app's routes. */
export function entityPath(entityType: NotifyEntity | null | undefined, entityId: string | null | undefined): string | undefined {
  if (!entityType || !entityId) return undefined;
  switch (entityType) {
    case "REIMBURSEMENT": return `/requests/${entityId}`;
    case "VENDOR_REQUEST": return `/vendors/requests/${entityId}`;
    case "VENDOR": return `/vendors/${entityId}`;
    case "TICKET": return `/tickets/${entityId}`;
    case "LINE_ITEM": return `/budget`;
    case "DEPARTMENT": return `/budget/${entityId}`;
    case "INCOME_ENTRY": return `/income`;
    case "FEST": return `/dashboard`;
  }
}

export const money = (paise: number) => formatPaise(paise);

async function resolveRecipients(tx: Tx, input: NotifyInput): Promise<string[]> {
  const recipients = new Set(input.toUsers ?? []);

  if (input.toDepartmentHods?.length) {
    const hods = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.festId, input.festId),
      inArray(users.departmentId, input.toDepartmentHods),
      inArray(users.role, ["DEPT_HOD", "FINANCE_HOD"]),
      eq(users.status, "ACTIVE"),
    ));
    for (const h of hods) recipients.add(h.id);
  }

  if (input.toDepartmentMembers?.length) {
    const members = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.festId, input.festId),
      inArray(users.departmentId, input.toDepartmentMembers),
      eq(users.status, "ACTIVE"),
    ));
    for (const m of members) recipients.add(m.id);
  }

  if (input.toRoles?.length) {
    const byRole = await tx.select({ id: users.id }).from(users).where(and(
      eq(users.festId, input.festId),
      inArray(users.role, input.toRoles),
      eq(users.status, "ACTIVE"),
    ));
    for (const r of byRole) recipients.add(r.id);
  }

  if (input.exceptUserId) recipients.delete(input.exceptUserId);
  return [...recipients];
}

export async function notify(tx: Tx, input: NotifyInput): Promise<number> {
  const recipients = await resolveRecipients(tx, input);
  if (recipients.length === 0) return 0;

  const base = {
    festId: input.festId,
    type: input.type,
    entityType: (input.entityType ?? null) as NotifyEntity | null,
    entityId: input.entityId ?? null,
    title: input.title,
    body: input.body ?? null,
    payload: input.blocks?.length || input.footnote
      ? { blocks: input.blocks ?? [], footnote: input.footnote ?? null }
      : null,
  };

  const rows = recipients.flatMap((recipientId) => [
    { ...base, recipientId, channel: "IN_APP" as const },
    ...(input.inAppOnly ? [] : [{ ...base, recipientId, channel: "EMAIL" as const }]),
  ]);

  await tx.insert(notifications).values(rows);
  return recipients.length;
}

/* ------------------------------------------------------------------- outbox */

interface OutboxRow {
  id: string;
  title: string;
  body: string | null;
  entityType: NotifyEntity | null;
  entityId: string | null;
  payload: { blocks?: { label: string; value: string }[]; footnote?: string | null } | null;
  email: string;
  name: string;
}

export function outboxMessage(row: OutboxRow): EmailMessage {
  return {
    to: row.email,
    subject: row.title,
    heading: row.title,
    body: row.body,
    blocks: row.payload?.blocks ?? [],
    footnote: row.payload?.footnote ?? undefined,
    actionPath: entityPath(row.entityType, row.entityId),
    actionLabel: "Open in Yugaantar",
  };
}

/**
 * Sends pending EMAIL notifications. Called after a write commits, and again by the
 * nightly sweep so a provider outage costs a delay rather than a lost message.
 * Rows older than seven days are abandoned — a week-late approval email is noise.
 */
export async function flushOutbox(limit = 100): Promise<{ sent: number; failed: number }> {
  const pending = (await db
    .select({
      id: notifications.id,
      title: notifications.title,
      body: notifications.body,
      entityType: notifications.entityType,
      entityId: notifications.entityId,
      payload: notifications.payload,
      email: users.email,
      name: users.name,
    })
    .from(notifications)
    .innerJoin(users, eq(users.id, notifications.recipientId))
    .where(and(
      eq(notifications.channel, "EMAIL"),
      isNull(notifications.sentAt),
      isNull(notifications.failedAt),
      eq(users.status, "ACTIVE"),
      sql`${notifications.createdAt} > now() - interval '7 days'`,
    ))
    .orderBy(notifications.createdAt)
    .limit(limit)) as unknown as OutboxRow[];

  let sent = 0;
  let failed = 0;

  for (const row of pending) {
    const ok = await sendEmail(outboxMessage(row));
    if (ok) {
      sent += 1;
      await db.update(notifications).set({ sentAt: new Date() }).where(eq(notifications.id, row.id));
    } else {
      failed += 1;
      await db.update(notifications)
        .set({ attempts: sql`${notifications.attempts} + 1` })
        .where(eq(notifications.id, row.id));
    }
  }

  // Give up on anything that has failed repeatedly, so the queue drains.
  await db.update(notifications).set({ failedAt: new Date() }).where(and(
    eq(notifications.channel, "EMAIL"),
    isNull(notifications.sentAt),
    isNull(notifications.failedAt),
    sql`${notifications.attempts} >= 5`,
  ));

  // Abandon the genuinely stale.
  await db.update(notifications).set({ failedAt: new Date() }).where(and(
    eq(notifications.channel, "EMAIL"),
    isNull(notifications.sentAt),
    isNull(notifications.failedAt),
    lt(notifications.createdAt, new Date(Date.now() - 7 * 24 * 3600_000)),
  ));

  return { sent, failed };
}

/* -------------------------------------------------------------------- inbox */

export async function inbox(actor: Actor, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return db.select().from(notifications)
    .where(and(
      eq(notifications.recipientId, actor.id),
      eq(notifications.channel, "IN_APP"),
      opts.unreadOnly ? isNull(notifications.readAt) : undefined,
    ))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50);
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(notifications)
    .where(and(
      eq(notifications.recipientId, actor.id),
      eq(notifications.channel, "IN_APP"),
      isNull(notifications.readAt),
    ));
  return row?.n ?? 0;
}

/** Marks the given ids read, or everything when no ids are given. */
export async function markRead(actor: Actor, ids?: string[]) {
  const updated = await db.update(notifications).set({ readAt: new Date() })
    .where(and(
      eq(notifications.recipientId, actor.id),
      isNull(notifications.readAt),
      ids?.length ? inArray(notifications.id, ids) : undefined,
    ))
    .returning({ id: notifications.id });
  return { marked: updated.length };
}
