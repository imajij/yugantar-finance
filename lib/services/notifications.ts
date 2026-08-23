/**
 * In-app notifications (PRD 11). Email is a channel this writes rows for; the
 * sender is not built yet, so rows stay unsent and the inbox still works.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { notifications, users } from "@/db/schema";
import type { Actor } from "@/lib/authz";

export interface NotifyInput {
  festId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: "REIMBURSEMENT" | "VENDOR_REQUEST" | "TICKET" | "LINE_ITEM" | "INCOME_ENTRY" | "DEPARTMENT";
  entityId?: string;
  toUsers?: string[];
  toDepartmentHods?: string[];
}

export async function notify(tx: Tx, input: NotifyInput) {
  const recipients = new Set(input.toUsers ?? []);

  if (input.toDepartmentHods?.length) {
    const hods = await tx.select({ id: users.id }).from(users)
      .where(and(
        eq(users.festId, input.festId),
        inArray(users.departmentId, input.toDepartmentHods),
        inArray(users.role, ["DEPT_HOD", "FINANCE_HOD"]),
        eq(users.status, "ACTIVE"),
      ));
    for (const h of hods) recipients.add(h.id);
  }
  if (recipients.size === 0) return;

  await tx.insert(notifications).values([...recipients].map((recipientId) => ({
    festId: input.festId,
    recipientId,
    type: input.type,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    title: input.title,
    body: input.body ?? null,
  })));
}

export async function inbox(actor: Actor, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return db.select().from(notifications)
    .where(and(
      eq(notifications.recipientId, actor.id),
      opts.unreadOnly ? isNull(notifications.readAt) : undefined,
    ))
    .orderBy(desc(notifications.createdAt))
    .limit(opts.limit ?? 50);
}

export async function unreadCount(actor: Actor): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(notifications)
    .where(and(eq(notifications.recipientId, actor.id), isNull(notifications.readAt)));
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
