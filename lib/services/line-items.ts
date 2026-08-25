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
import { attachments, departments, expenseTypes, lineItems } from "@/db/schema";
import { assertCan, can, type Actor } from "@/lib/authz";
import { ApiError, notFound, overAllocation } from "@/lib/api";
import { assertLineItemTransition, type LineItemAction } from "@/lib/state-machines/line-item";
import { satisfiesActorConstraints } from "@/lib/authz";
import { lineItemTotals } from "@/lib/queries/budget";
import { evaluateLineItemFlags } from "@/lib/flags";
import { recordAudit, snapshot } from "./audit";

const AUDITED = ["name", "description", "plannedPaise", "status", "defaultExpenseTypeId", "reviewedAt"] as const;

/**
 * Locks the department row so two concurrent creates cannot both fit under the cap —
 * and confirms the department is this fest's.
 *
 * The fest check lives here rather than at each call site because this is where the
 * department is already loaded, and because `can()` cannot do it: a Finance HOD is
 * permitted `lineItem.create` for any department, so a department id from another
 * fest passed the permission check and produced a line item belonging to fest A
 * charged against fest B's allocation. A UUID is not a secret (18.2 rule 10), so an
 * id from a URL or an export was enough.
 */
async function assertFitsAllocation(
  tx: Tx, festId: string, departmentId: string, plannedPaise: number, excludeLineItemId?: string,
): Promise<void> {
  const [dept] = await tx
    .select({ allocatedPaise: departments.allocatedPaise, name: departments.name, festId: departments.festId })
    .from(departments)
    .where(eq(departments.id, departmentId))
    .for("update");
  if (!dept || dept.festId !== festId) throw notFound("Department");

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
    await assertFitsAllocation(tx, actor.festId, input.departmentId, input.plannedPaise);
    await assertExpenseTypeBelongsToFest(tx, actor.festId, input.defaultExpenseTypeId);

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
    await assertExpenseTypeBelongsToFest(tx, actor.festId, input.defaultExpenseTypeId);

    if (input.plannedPaise !== undefined && input.plannedPaise !== before.plannedPaise) {
      await assertFitsAllocation(tx, actor.festId, before.departmentId, input.plannedPaise, id);
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
        // Matches `addDocument`: a file already withdrawn is not one to bind.
        isNull(attachments.removedAt),
      ))
      .returning({ id: attachments.id });
    if (updated.length === 0) {
      throw new ApiError("VALIDATION_ERROR", `Attachment ${attachmentId} is not available to bind`);
    }
  }
}

/**
 * An expense type from another fest would put that fest's label on this fest's
 * spending, and show up in exports. Same class of bug as the department: a UUID from
 * anywhere passed straight into a foreign key.
 */
async function assertExpenseTypeBelongsToFest(
  tx: Tx, festId: string, expenseTypeId: string | null | undefined,
): Promise<void> {
  if (!expenseTypeId) return;
  const [row] = await tx.select({ id: expenseTypes.id }).from(expenseTypes)
    .where(and(eq(expenseTypes.id, expenseTypeId), eq(expenseTypes.festId, festId)))
    .limit(1);
  if (!row) throw notFound("Expense type");
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

/* -------------------------------------------------- supporting documents (20.5) */

export interface DocumentInput {
  /** A file already uploaded through the presign flow… */
  attachmentId?: string;
  /** …or a link to an online listing, which skips the upload entirely (20.2 step 5). */
  url?: string;
  label: string;
  sourceName?: string | null;
  quotedAmountPaise?: number | null;
  purpose?: "QUOTE" | "LISTING" | "OTHER";
}

/**
 * Adding a supporting document re-runs F13 and F14: the document threshold is what
 * makes a line item attachable at all (21.4), and the lowest quote is what F14
 * compares the planned amount against. Both have to be reconsidered here, in the
 * same transaction, or the flags describe a state that no longer exists.
 */
export async function addDocument(actor: Actor, lineItemId: string, input: DocumentInput) {
  if (!input.attachmentId && !input.url) {
    throw new ApiError("VALIDATION_ERROR", "A document needs either an uploaded file or a link");
  }

  return db.transaction(async (tx) => {
    const item = await loadForWrite(tx, actor, lineItemId, "lineItem.document.manage");

    const [{ count }] = (await tx.execute<{ count: string }>(sql`
      select count(*) as count from attachments
      where entity_type = 'LINE_ITEM' and entity_id = ${lineItemId} and removed_at is null
    `)) as unknown as { count: string }[];
    if (Number(count) + 1 > MAX_DOCUMENTS) {
      throw new ApiError("VALIDATION_ERROR", `A line item may carry at most ${MAX_DOCUMENTS} supporting documents`);
    }

    let doc;
    if (input.attachmentId) {
      const [updated] = await tx.update(attachments)
        .set({
          entityType: "LINE_ITEM", entityId: lineItemId,
          label: input.label,
          sourceName: input.sourceName ?? null,
          quotedAmountPaise: input.quotedAmountPaise ?? null,
        })
        .where(and(
          eq(attachments.id, input.attachmentId),
          eq(attachments.festId, actor.festId),
          eq(attachments.uploadedBy, actor.id),
          isNull(attachments.entityId),
          isNull(attachments.removedAt),
        ))
        .returning();
      if (!updated) {
        throw new ApiError("VALIDATION_ERROR", "That upload was already used, removed, or is not yours");
      }
      doc = updated;
    } else {
      let parsed: URL;
      try {
        parsed = new URL(input.url!);
      } catch {
        throw new ApiError("VALIDATION_ERROR", "That is not a valid URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new ApiError("VALIDATION_ERROR", "Links must be http or https");
      }
      const [created] = await tx.insert(attachments).values({
        festId: actor.festId,
        entityType: "LINE_ITEM",
        entityId: lineItemId,
        purpose: input.purpose ?? "LISTING",
        kind: "LINK",
        url: parsed.toString(),
        label: input.label,
        sourceName: input.sourceName ?? null,
        quotedAmountPaise: input.quotedAmountPaise ?? null,
        uploadedBy: actor.id,
      }).returning();
      doc = created;
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "LINE_ITEM", entityId: item.id, actorId: actor.id,
      action: "line_item.document.add",
      after: {
        attachment_id: doc.id, kind: doc.kind, label: doc.label,
        source_name: doc.sourceName, quoted_amount_paise: doc.quotedAmountPaise,
      },
    });

    await evaluateLineItemFlags(tx, item.id);
    return doc;
  });
}

/** 20.5 — correcting a label, a source or a quoted amount. Also re-runs F14. */
export async function updateDocument(
  actor: Actor, lineItemId: string, attachmentId: string,
  patch: { label?: string; sourceName?: string | null; quotedAmountPaise?: number | null },
) {
  return db.transaction(async (tx) => {
    const item = await loadForWrite(tx, actor, lineItemId, "lineItem.document.manage");

    const [before] = await tx.select().from(attachments)
      .where(and(
        eq(attachments.id, attachmentId),
        eq(attachments.entityType, "LINE_ITEM"),
        eq(attachments.entityId, lineItemId),
        isNull(attachments.removedAt),
      )).limit(1);
    if (!before) throw notFound("Document");

    const [after] = await tx.update(attachments).set({
      label: patch.label ?? before.label,
      sourceName: patch.sourceName === undefined ? before.sourceName : patch.sourceName,
      quotedAmountPaise: patch.quotedAmountPaise === undefined ? before.quotedAmountPaise : patch.quotedAmountPaise,
    }).where(eq(attachments.id, attachmentId)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "LINE_ITEM", entityId: item.id, actorId: actor.id,
      action: "line_item.document.update",
      before: { label: before.label, source_name: before.sourceName, quoted_amount_paise: before.quotedAmountPaise },
      after: { label: after.label, source_name: after.sourceName, quoted_amount_paise: after.quotedAmountPaise },
    });

    await evaluateLineItemFlags(tx, item.id);
    return after;
  });
}

/** 20.5 — the documents on a line item, with the lowest quote F14 compares against. */
export async function listDocuments(actor: Actor, lineItemId: string, opts: { includeRemoved?: boolean } = {}) {
  const [item] = await db.select().from(lineItems)
    .where(and(eq(lineItems.id, lineItemId), eq(lineItems.festId, actor.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!item) throw notFound("Line item");
  assertCan(actor, "lineItem.view", { festId: actor.festId, departmentId: item.departmentId });

  // Removed documents are Finance's business only — they are the audit trail of a
  // quote that was swapped out, which is exactly what 8.2's F14 is about.
  const includeRemoved = opts.includeRemoved && can(actor, "budgetReview.view", { festId: actor.festId });

  const docs = await db.select().from(attachments)
    .where(and(
      eq(attachments.entityType, "LINE_ITEM"),
      eq(attachments.entityId, lineItemId),
      includeRemoved ? undefined : isNull(attachments.removedAt),
    ))
    .orderBy(attachments.createdAt);

  const quotes = docs
    .filter((d) => !d.removedAt && d.quotedAmountPaise !== null)
    .map((d) => d.quotedAmountPaise as number);

  return {
    documents: docs,
    lowest_quote_paise: quotes.length ? Math.min(...quotes) : null,
    planned_paise: item.plannedPaise,
  };
}

/**
 * 20.5 `/budget-review` — Finance's sweep across every department.
 *
 * Ordered so the items that need a decision come first: unreviewed items above the
 * document threshold, then anything whose planned amount sits above its lowest
 * quote (F14), then the rest. That ordering *is* the screen's purpose.
 */
export async function budgetReview(actor: Actor) {
  assertCan(actor, "budgetReview.view", { festId: actor.festId });

  return (await db.execute(sql`
    with docs as (
      select a.entity_id as line_item_id,
             count(*)::int as document_count,
             min(a.quoted_amount_paise) as lowest_quote_paise
        from attachments a
       where a.entity_type = 'LINE_ITEM' and a.removed_at is null
       group by a.entity_id
    )
    select li.id, li.name, li.status::text as status, li.planned_paise,
           li.reviewed_at, ru.name as reviewed_by,
           d.id as department_id, d.name as department,
           coalesce(docs.document_count, 0) as document_count,
           docs.lowest_quote_paise,
           v.pending_paise, v.committed_paise, v.spent_paise, v.available_paise,
           threshold.value as doc_threshold_paise,
           (li.planned_paise >= threshold.value and coalesce(docs.document_count, 0) = 0) as needs_documents,
           (docs.lowest_quote_paise is not null and li.planned_paise > docs.lowest_quote_paise) as above_lowest_quote,
           (select count(*)::int from flags f
             where f.entity_type = 'LINE_ITEM' and f.entity_id = li.id and f.status = 'OPEN') as open_flags
      from line_items li
      join departments d on d.id = li.department_id
      left join docs on docs.line_item_id = li.id
      left join v_line_item_totals v on v.line_item_id = li.id
      left join users ru on ru.id = li.reviewed_by
      cross join lateral (
        select coalesce((f.settings->>'line_item_doc_threshold_paise')::bigint, 0) as value
          from fests f where f.id = li.fest_id
      ) threshold
     where li.fest_id = ${actor.festId} and li.deleted_at is null
     order by
       (li.reviewed_at is null and li.planned_paise >= threshold.value
        and coalesce(docs.document_count, 0) = 0) desc,
       (docs.lowest_quote_paise is not null and li.planned_paise > docs.lowest_quote_paise) desc,
       li.reviewed_at nulls first,
       li.planned_paise desc
  `)) as unknown as Record<string, unknown>[];
}
