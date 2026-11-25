import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachments, auditEvents, lineItems } from "@/db/schema";
import { assertCan } from "@/lib/authz";
import { notFound, parseBody, route } from "@/lib/api";
import { lineItemTotals } from "@/lib/queries/budget";
import { deleteLineItem, updateLineItem } from "@/lib/services/line-items";

/** PRD 20.5 / 20.1 — one call returns totals, documents, flags and timeline. */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const [item] = await db.select().from(lineItems)
    .where(and(eq(lineItems.id, params.id), eq(lineItems.festId, user.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!item) throw notFound("Line item");
  assertCan(user, "lineItem.view", { festId: user.festId, departmentId: item.departmentId });

  const [totals, documents, timeline] = await Promise.all([
    lineItemTotals(item.id),
    db.select().from(attachments).where(and(
      eq(attachments.entityType, "LINE_ITEM"), eq(attachments.entityId, item.id), isNull(attachments.removedAt),
    )),
    db.select().from(auditEvents).where(and(
      eq(auditEvents.entityType, "LINE_ITEM"), eq(auditEvents.entityId, item.id),
    )).orderBy(auditEvents.createdAt),
  ]);

  const quotes = documents.map((d) => d.quotedAmountPaise).filter((q): q is number => q != null);

  return {
    id: item.id, name: item.name, description: item.description, status: item.status,
    department_id: item.departmentId,
    planned_paise: item.plannedPaise,
    pending_paise: totals?.pendingPaise ?? 0,
    committed_paise: totals?.committedPaise ?? 0,
    spent_paise: totals?.spentPaise ?? 0,
    available_paise: totals?.availablePaise ?? item.plannedPaise,
    reviewed_at: item.reviewedAt,
    lowest_quote_paise: quotes.length ? Math.min(...quotes) : null,
    documents, timeline,
  };
});

const patchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).nullish(),
  planned_paise: z.number().int().positive().optional(),
  default_expense_type_id: z.uuid().nullish(),
  reason: z.string().max(300).optional(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const body = await parseBody(request, patchSchema);
  return updateLineItem(user, params.id, {
    name: body.name,
    description: body.description,
    plannedPaise: body.planned_paise,
    defaultExpenseTypeId: body.default_expense_type_id,
    reason: body.reason,
  });
});

/**
 * 20.5 — deleting one. Soft, audited, and refused once anything is charged against
 * it; `deleteLineItem` says why, and closing is the alternative it points at.
 */
export const DELETE = route<{ id: string }>(async ({ user, params, request }) => {
  const reason = new URL(request.url).searchParams.get("reason") ?? undefined;
  return deleteLineItem(user, params.id, reason);
});
