import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { assertCan, can } from "@/lib/authz";
import { overAllocation, parseBody, route } from "@/lib/api";
import { recordAudit } from "@/lib/services/audit";
import { ensureDepartmentChannel } from "@/lib/services/chat";
import { departmentTotalsForFest, festTotals } from "@/lib/queries/budget";
import { lockFestForAllocation } from "@/lib/services/budget";

/** PRD 20.4 — budget figures only for departments the caller may see. */
export const GET = route(async ({ user }) => {
  const rows = await db
    .select({
      id: departments.id, name: departments.name, slug: departments.slug,
      kind: departments.kind, allocatedPaise: departments.allocatedPaise, isActive: departments.isActive,
    })
    .from(departments)
    .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
    .orderBy(asc(departments.name));

  const hods = await db
    .select({ id: users.id, name: users.name, email: users.email, departmentId: users.departmentId })
    .from(users)
    .where(and(eq(users.festId, user.festId), eq(users.role, "DEPT_HOD")));

  const totals = new Map((await departmentTotalsForFest(user.festId)).map((t) => [t.departmentId, t]));

  return {
    data: rows.map((d) => {
      const visible = can(user, "department.budget.view", { festId: user.festId, departmentId: d.id });
      const t = totals.get(d.id);
      return {
        id: d.id, name: d.name, slug: d.slug, kind: d.kind,
        hods: hods.filter((h) => h.departmentId === d.id).map((h) => ({ id: h.id, name: h.name, email: h.email })),
        ...(visible && t
          ? {
              allocated_paise: t.allocatedPaise,
              planned_paise: t.plannedPaise,
              pending_paise: t.pendingPaise,
              committed_paise: t.committedPaise,
              spent_paise: t.spentPaise,
              available_paise: t.availablePaise,
            }
          : {}),
      };
    }),
    next_cursor: null,
  };
});

const createSchema = z.object({
  name: z.string().min(2).max(60),
  slug: z.string().regex(/^[a-z0-9-]+$/, "Lowercase letters, digits and hyphens only").max(40),
  allocated_paise: z.number().int().min(0).default(0),
});

export const POST = route(async ({ user, request }) => {
  assertCan(user, "department.manage", { festId: user.festId });
  const body = await parseBody(request, createSchema);

  return db.transaction(async (tx) => {
    // Σ allocations may never exceed the fest total (4.7 — the one hard block). The
    // same lock every transfer takes: a department created with an allocation moves
    // money out of the reserve as surely as a transfer does, and two of them at once
    // would otherwise each read a reserve the other was already spending.
    await lockFestForAllocation(tx, user.festId);
    const totals = await festTotals(user.festId, tx);
    if (totals && totals.allocatedPaise + body.allocated_paise > totals.totalBudgetPaise) {
      throw overAllocation("Department allocations would exceed the fest total budget", {
        total_budget_paise: totals.totalBudgetPaise,
        already_allocated_paise: totals.allocatedPaise,
        requested_paise: body.allocated_paise,
      });
    }

    const [row] = await tx
      .insert(departments)
      .values({
        festId: user.festId, name: body.name, slug: body.slug,
        kind: "BUDGET", allocatedPaise: body.allocated_paise,
      })
      .returning();

    // Every department gets its channel at the moment it exists, so nobody has to
    // think about creating one and nobody lands somewhere with nothing in it.
    await ensureDepartmentChannel(tx, user.festId, row.id, user.id);

    await recordAudit(tx, {
      festId: user.festId, entityType: "DEPARTMENT", entityId: row.id, actorId: user.id,
      action: "department.create", after: { name: row.name, slug: row.slug, allocated_paise: row.allocatedPaise },
    });
    return row;
  });
});
