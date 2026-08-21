/**
 * Line items (PRD 7.1, 7.5, 20.5). Every write is one transaction with its audit
 * event inside it (18.2 rule 5).
 *
 * Two invariants the database cannot express on its own, so they are enforced here
 * under `SELECT ... FOR UPDATE` on the department row:
 *   Σ line item planned ≤ department allocation
 *   a line item's planned amount never drops below its own committed + spent
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { attachments, departments, lineItems } from "@/db/schema";
import { assertCan, type Actor } from "@/lib/authz";
import { ApiError, notFound, overAllocation } from "@/lib/api";
import { assertLineItemTransition, type LineItemAction } from "@/lib/state-machines/line-item";
import { satisfiesActorConstraints } from "@/lib/authz";
import { lineItemTotals } from "@/lib/queries/budget";
import { recordAudit, snapshot } from "./audit";

const AUDITED = ["name", "description", "plannedPaise", "status", "defaultExpenseTypeId", "reviewedAt"] as const;

/** Locks the department row so two concurrent creates cannot both fit under the cap. */
async function assertFitsAllocation(
  tx: Tx, departmentId: string, plannedPaise: number, excludeLineItemId?: string,
): Promise<void> {
  const [dept] = await tx
    .select({ allocatedPaise: departments.allocatedPaise, name: departments.name })
    .from(departments)
    .where(eq(departments.id, departmentId))
    .for("update");
  if (!dept) throw notFound("Department");

  const [{ planned }] = (await tx.execute<{ planned: string }>(sql`
    select coalesce(sum(planned_paise), 0) as planned
    from line_items
    where department_id = ${departmentId}
      and deleted_at is null
      ${excludeLineItemId ? sql`and id <> ${excludeLineItemId}` : sql``}
  `)) as unknown as { planned: string }[];

  const total = Number(planned) + plannedPaise;
  if (total > dept.allocatedPaise) {
    throw overAllocation(`Line items for ${dept.name} would total more than its allocation`, {
      allocated_paise: dept.allocatedPaise,
      other_line_items_paise: Number(planned),
      requested_paise: plannedPaise,
      over_by_paise: total - dept.allocatedPaise,
    });
  }
}

export interface CreateLineItemInput {
  departmentId: string;
  name: string;
  description?: string | null;
  plannedPaise: number;
  defaultExpenseTypeId?: string | null;
  attachmentIds?: string[];
}

export async function createLineItem(actor: Actor, input: CreateLineItemInput) {
  assertCan(actor, "lineItem.create", { festId: actor.festId, departmentId: input.departmentId });

  return db.transaction(async (tx) => {
    await assertFitsAllocation(tx, input.departmentId, input.plannedPaise);

    const [row] = await tx.insert(lineItems).values({
      festId: actor.festId,
      departmentId: input.departmentId,
      name: input.name,
      description: input.description ?? null,
      plannedPaise: input.plannedPaise,
      defaultExpenseTypeId: input.defaultExpenseTypeId ?? null,
      createdBy: actor.id,
    }).returning();

    if (input.attachmentIds?.length) {
      await bindAttachments(tx, actor, row.id, input.attachmentIds);
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "LINE_ITEM", entityId: row.id, actorId: actor.id,
      action: "line_item.create", after: snapshot(row, AUDITED),
    });
    return row;
  });
}

export interface UpdateLineItemInput {
  name?: string;
  description?: string | null;
  plannedPaise?: number;
  defaultExpenseTypeId?: string | null;
  reason?: string;
}

export async function updateLineItem(actor: Actor, id: string, input: UpdateLineItemInput) {
  return db.transaction(async (tx) => {
    const before = await loadForWrite(tx, actor, id, "lineItem.edit");

    if (input.plannedPaise !== undefined && input.plannedPaise !== before.plannedPaise) {
      await assertFitsAllocation(tx, before.departmentId, input.plannedPaise, id);
      // 7.5 — a line item may not shrink below money already committed or spent against it.
      const totals = await lineItemTotals(id, tx);
      const floor = (totals?.committedPaise ?? 0) + (totals?.spentPaise ?? 0);
      if (input.plannedPaise < floor) {
        throw overAllocation("A line item cannot be reduced below its committed + spent", {
          committed_plus_spent_paise: floor, requested_paise: input.plannedPaise,
        });
      }
    }

    const [after] = await tx.update(lineItems).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.plannedPaise !== undefined ? { plannedPaise: input.plannedPaise } : {}),
      ...(input.defaultExpenseTypeId !== undefined ? { defaultExpenseTypeId: input.defaultExpenseTypeId } : {}),
      updatedAt: new Date(),
    }).where(eq(lineItems.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "LINE_ITEM", entityId: id, actorId: actor.id,
      action: "line_item.update",
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED), reason: input.reason,
    });
    return after;
  });
}

export async function transitionLineItem(
  actor: Actor, id: string, action: LineItemAction, body: Record<string, unknown> = {},
) {
  return db.transaction(async (tx) => {
    const before = await loadForWrite(
      tx, actor, id, action === "MARK_REVIEWED" || action === "UNMARK_REVIEWED" ? "lineItem.markReviewed" : "lineItem.close",
    );

    const transition = assertLineItemTransition(before.status, action, actor.role, body);
    const resource = { festId: actor.festId, departmentId: before.departmentId, targetDepartmentId: before.departmentId };
    if (!satisfiesActorConstraints(transition.actor, actor, resource)) {
      throw new ApiError("FORBIDDEN", `You may not ${action} this line item`);
    }

    const reason = typeof body.reason === "string" ? body.reason : null;
    const now = new Date();
    const patch =
      action === "CLOSE" ? { status: "CLOSED" as const, closedAt: now, closedBy: actor.id, closeReason: reason }
      : action === "REOPEN" ? { status: "OPEN" as const, closedAt: null, closedBy: null, closeReason: reason }
      : action === "MARK_REVIEWED" ? { reviewedAt: now, reviewedBy: actor.id }
      : { reviewedAt: null, reviewedBy: null };

    const [after] = await tx.update(lineItems).set({ ...patch, updatedAt: now })
      .where(eq(lineItems.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "LINE_ITEM", entityId: id, actorId: actor.id,
      action: `line_item.transition.${action}`,
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED), reason,
    });
    return after;
  });
}

/** 7.5 — removal is soft: the file is retained and marked removed, and it is logged. */
export async function removeDocument(actor: Actor, lineItemId: string, attachmentId: string) {
  return db.transaction(async (tx) => {
    const item = await loadForWrite(tx, actor, lineItemId, "lineItem.document.manage");
    const [doc] = await tx.select().from(attachments)
      .where(and(
        eq(attachments.id, attachmentId),
        eq(attachments.entityType, "LINE_ITEM"),
        eq(attachments.entityId, lineItemId),
        isNull(attachments.removedAt),
      )).limit(1);
    if (!doc) throw notFound("Document");

    await tx.update(attachments)
      .set({ removedAt: new Date(), removedBy: actor.id })
      .where(eq(attachments.id, attachmentId));

    await recordAudit(tx, {
      festId: actor.festId, entityType: "LINE_ITEM", entityId: item.id, actorId: actor.id,
      action: "line_item.document.remove",
      before: { attachment_id: attachmentId, label: doc.label, quoted_amount_paise: doc.quotedAmountPaise },
    });
    return { ok: true };
  });
}

const MAX_DOCUMENTS = 10; // PRD 7.1

async function bindAttachments(tx: Tx, actor: Actor, lineItemId: string, attachmentIds: string[]) {
  const [{ count }] = (await tx.execute<{ count: string }>(sql`
    select count(*) as count from attachments
    where entity_type = 'LINE_ITEM' and entity_id = ${lineItemId} and removed_at is null
  `)) as unknown as { count: string }[];
  if (Number(count) + attachmentIds.length > MAX_DOCUMENTS) {
    throw new ApiError("VALIDATION_ERROR", `A line item may carry at most ${MAX_DOCUMENTS} supporting documents`);
  }

  for (const attachmentId of attachmentIds) {
    const updated = await tx.update(attachments)
      .set({ entityType: "LINE_ITEM", entityId: lineItemId })
      .where(and(
        eq(attachments.id, attachmentId),
        eq(attachments.festId, actor.festId),
        eq(attachments.uploadedBy, actor.id),   // only your own uploads (20.2 step 4)
        isNull(attachments.entityId),
      ))
      .returning({ id: attachments.id });
    if (updated.length === 0) {
      throw new ApiError("VALIDATION_ERROR", `Attachment ${attachmentId} is not available to bind`);
    }
  }
}

async function loadForWrite(
  tx: Tx, actor: Actor, id: string,
  action: "lineItem.edit" | "lineItem.close" | "lineItem.markReviewed" | "lineItem.document.manage",
) {
  const [row] = await tx.select().from(lineItems)
    .where(and(eq(lineItems.id, id), eq(lineItems.festId, actor.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Line item");
  assertCan(actor, action, { festId: actor.festId, departmentId: row.departmentId });
  return row;
}

/** Used by the request forms: only OPEN items can receive new requests (7.5). */
export async function openLineItemsFor(departmentId: string, festId: string) {
  return db.select({ id: lineItems.id, name: lineItems.name, plannedPaise: lineItems.plannedPaise })
    .from(lineItems)
    .where(and(
      eq(lineItems.departmentId, departmentId),
      eq(lineItems.festId, festId),
      eq(lineItems.status, "OPEN"),
      isNull(lineItems.deletedAt),
    ));
}
