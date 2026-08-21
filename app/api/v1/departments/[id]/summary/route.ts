import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { attachments, departments, lineItems } from "@/db/schema";
import { assertCan, can } from "@/lib/authz";
import { notFound, route } from "@/lib/api";
import { departmentTotals, lineItemTotalsForDepartment } from "@/lib/queries/budget";

/**
 * PRD 20.4 — the department row from v_department_totals plus its line items with
 * their own five numbers and supporting documents. Members see this read-only (17.7).
 */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const [dept] = await db
    .select()
    .from(departments)
    .where(and(eq(departments.id, params.id), eq(departments.festId, user.festId)))
    .limit(1);
  if (!dept) throw notFound("Department");

  assertCan(user, "department.budget.view", { festId: user.festId, departmentId: dept.id });

  const items = await db
    .select()
    .from(lineItems)
    .where(and(eq(lineItems.departmentId, dept.id), isNull(lineItems.deletedAt)))
    .orderBy(asc(lineItems.name));

  const totals = new Map((await lineItemTotalsForDepartment(dept.id)).map((t) => [t.lineItemId, t]));

  const docs = items.length
    ? await db
        .select()
        .from(attachments)
        .where(and(
          eq(attachments.entityType, "LINE_ITEM"),
          inArray(attachments.entityId, items.map((i) => i.id)),
          isNull(attachments.removedAt),
        ))
    : [];

  const deptTotals = await departmentTotals(dept.id);
  const canEdit = can(user, "lineItem.edit", { festId: user.festId, departmentId: dept.id });

  return {
    department: {
      id: dept.id, name: dept.name, slug: dept.slug, kind: dept.kind,
      allocated_paise: deptTotals?.allocatedPaise ?? dept.allocatedPaise,
      planned_paise: deptTotals?.plannedPaise ?? 0,
      pending_paise: deptTotals?.pendingPaise ?? 0,
      committed_paise: deptTotals?.committedPaise ?? 0,
      spent_paise: deptTotals?.spentPaise ?? 0,
      available_paise: deptTotals?.availablePaise ?? 0,
      // The gap between Allocated and Planned is the department's unplanned buffer (6.2).
      unplanned_buffer_paise: (deptTotals?.allocatedPaise ?? 0) - (deptTotals?.plannedPaise ?? 0),
    },
    line_items: items.map((i) => {
      const t = totals.get(i.id);
      const mine = docs.filter((d) => d.entityId === i.id);
      return {
        id: i.id, name: i.name, description: i.description, status: i.status,
        planned_paise: i.plannedPaise,
        pending_paise: t?.pendingPaise ?? 0,
        committed_paise: t?.committedPaise ?? 0,
        spent_paise: t?.spentPaise ?? 0,
        available_paise: t?.availablePaise ?? i.plannedPaise,
        reviewed_at: i.reviewedAt,
        document_count: mine.length,
        lowest_quote_paise: mine.reduce<number | null>(
          (lo, d) => (d.quotedAmountPaise != null && (lo === null || d.quotedAmountPaise < lo) ? d.quotedAmountPaise : lo),
          null,
        ),
        documents: mine.map((d) => ({
          id: d.id, kind: d.kind, label: d.label, source_name: d.sourceName,
          quoted_amount_paise: d.quotedAmountPaise, url: d.kind === "LINK" ? d.url : null,
          file_name: d.fileName,
        })),
      };
    }),
    can: { edit_line_items: canEdit },
  };
});
