import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { ApiError, conflict, notFound, parseBody, route } from "@/lib/api";
import { assertCan } from "@/lib/authz";
import { recordAudit, snapshot } from "@/lib/services/audit";

const AUDITED = ["name", "slug", "isActive"] as const;

const patch = z.object({
  name: z.string().min(2).max(60).optional(),
  slug: z.string().regex(/^[a-z0-9-]+$/, "Lowercase letters, digits and hyphens only").max(40).optional(),
  is_active: z.boolean().optional(),
});

/**
 * PRD 20.4 — rename or deactivate. `allocated_paise` is deliberately absent: an
 * allocation only ever moves through a budget transfer, so that every rupee that
 * changes hands has a reason and an audit row (7.1).
 */
export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  assertCan(user, "department.manage", { festId: user.festId });
  const b = await parseBody(request, patch);

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(departments)
      .where(and(eq(departments.id, params.id), eq(departments.festId, user.festId))).limit(1);
    if (!before) throw notFound("Department");

    if (b.is_active === false) {
      // Deactivating a department with money or people still on it would strand both.
      const [{ blockers }] = (await tx.execute<{ blockers: number }>(sql`
        select (
          (select count(*) from line_items
            where department_id = ${params.id} and deleted_at is null and status = 'OPEN')
        + (select count(*) from reimbursement_requests
            where department_id = ${params.id} and deleted_at is null
              and status in ('DRAFT','SUBMITTED','HOD_ENDORSED','APPROVED','ON_HOLD','SENT_BACK'))
        + (select count(*) from vendor_requests
            where department_id = ${params.id} and deleted_at is null
              and status not in ('CLOSED','DECLINED','CANCELLED'))
        )::int as blockers
      `)) as unknown as { blockers: number }[];
      if (Number(blockers) > 0) {
        throw conflict("Close the department's open line items and requests before deactivating it", {
          open_records: Number(blockers),
        });
      }
      if (before.allocatedPaise > 0) {
        throw conflict("Transfer the department's allocation back to Reserve before deactivating it", {
          allocated_paise: before.allocatedPaise,
        });
      }
      if (before.kind !== "BUDGET") {
        throw new ApiError("VALIDATION_ERROR", "The Finance and Core departments cannot be deactivated");
      }
    }

    const [after] = await tx.update(departments).set({
      name: b.name ?? before.name,
      slug: b.slug ?? before.slug,
      isActive: b.is_active ?? before.isActive,
      updatedAt: new Date(),
    }).where(eq(departments.id, params.id)).returning();

    await recordAudit(tx, {
      festId: user.festId, entityType: "DEPARTMENT", entityId: params.id, actorId: user.id,
      action: b.is_active === false ? "department.deactivate" : "department.update",
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
    });
    return after;
  });
});
