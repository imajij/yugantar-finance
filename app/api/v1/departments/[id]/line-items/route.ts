import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { lineItems } from "@/db/schema";
import { parseBody, parseQuery, route } from "@/lib/api";
import { assertCan } from "@/lib/authz";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { createLineItem, listDocuments } from "@/lib/services/line-items";

const query = z.object({ include: z.string().optional() });

/**
 * PRD 20.5 — a department's line items with their five numbers and document counts.
 * `?include=documents` folds the documents in, so the budget screen needs one call.
 */
export const GET = route<{ id: string }>(async ({ user, params, request }) => {
  assertCan(user, "lineItem.view", { festId: user.festId, departmentId: params.id });
  const q = parseQuery(request, query);

  const rows = await db.select({
    id: lineItems.id, name: lineItems.name, description: lineItems.description,
    status: lineItems.status, plannedPaise: lineItems.plannedPaise,
    defaultExpenseTypeId: lineItems.defaultExpenseTypeId,
    reviewedAt: lineItems.reviewedAt, closeReason: lineItems.closeReason,
    documentCount: sql<number>`(select count(*) from attachments a
      where a.entity_type = 'LINE_ITEM' and a.entity_id = ${lineItems.id} and a.removed_at is null)`.mapWith(Number),
    openFlags: sql<number>`(select count(*) from flags f
      where f.entity_type = 'LINE_ITEM' and f.entity_id = ${lineItems.id} and f.status = 'OPEN')`.mapWith(Number),
  }).from(lineItems)
    .where(and(
      eq(lineItems.departmentId, params.id),
      eq(lineItems.festId, user.festId),
      isNull(lineItems.deletedAt),
    ))
    .orderBy(lineItems.name);

  const totals = new Map((await lineItemTotalsForDepartment(params.id)).map((t) => [t.lineItemId, t]));
  const withDocuments = q.include === "documents";

  const data = await Promise.all(rows.map(async (r) => ({
    ...r,
    totals: totals.get(r.id) ?? null,
    ...(withDocuments ? { documents: (await listDocuments(user, r.id)).documents } : {}),
  })));

  return { data, next_cursor: null };
});

const schema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).nullish(),
  planned_paise: z.number().int().positive(),
  default_expense_type_id: z.uuid().nullish(),
  attachment_ids: z.array(z.uuid()).max(10).optional(),
});

/** PRD 20.5 — OVER_ALLOCATION if Σ line items would exceed the department allocation. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const body = await parseBody(request, schema);
  return createLineItem(user, {
    departmentId: params.id,
    name: body.name,
    description: body.description,
    plannedPaise: body.planned_paise,
    defaultExpenseTypeId: body.default_expense_type_id,
    attachmentIds: body.attachment_ids,
  });
});
