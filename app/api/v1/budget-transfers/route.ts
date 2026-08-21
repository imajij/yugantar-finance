import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { budgetTransfers, departments, users } from "@/db/schema";
import { assertCan, can } from "@/lib/authz";
import { parseBody, route } from "@/lib/api";
import { transferBudget } from "@/lib/services/budget";

/** PRD 20.4 — Finance and Management see every transfer; an HOD sees their own department's. */
export const GET = route(async ({ user }) => {
  assertCan(user, "audit.view", { festId: user.festId, departmentId: user.departmentId });
  const seesAll = can(user, "budget.transfer", { festId: user.festId }) || user.role === "MANAGEMENT";

  const rows = await db
    .select({
      id: budgetTransfers.id,
      amountPaise: budgetTransfers.amountPaise,
      reason: budgetTransfers.reason,
      createdAt: budgetTransfers.createdAt,
      fromDepartmentId: budgetTransfers.fromDepartmentId,
      toDepartmentId: budgetTransfers.toDepartmentId,
      createdByName: users.name,
    })
    .from(budgetTransfers)
    .innerJoin(users, eq(users.id, budgetTransfers.createdBy))
    .where(and(
      eq(budgetTransfers.festId, user.festId),
      seesAll ? undefined : or(
        eq(budgetTransfers.fromDepartmentId, user.departmentId),
        eq(budgetTransfers.toDepartmentId, user.departmentId),
      ),
    ))
    .orderBy(desc(budgetTransfers.createdAt))
    .limit(100);

  const names = new Map(
    (await db.select({ id: departments.id, name: departments.name })
      .from(departments).where(eq(departments.festId, user.festId)))
      .map((d) => [d.id, d.name]),
  );

  return {
    data: rows.map((r) => ({
      id: r.id,
      from: r.fromDepartmentId ? names.get(r.fromDepartmentId) ?? "—" : "Reserve",
      to: r.toDepartmentId ? names.get(r.toDepartmentId) ?? "—" : "Reserve",
      amount_paise: r.amountPaise,
      reason: r.reason,
      created_by: r.createdByName,
      created_at: r.createdAt,
    })),
    next_cursor: null,
  };
});

const schema = z.object({
  from_department_id: z.uuid().nullable(),
  to_department_id: z.uuid().nullable(),
  amount_paise: z.number().int().positive(),
  reason: z.string().min(3).max(300),
}).refine((v) => v.from_department_id !== null || v.to_department_id !== null, {
  message: "A transfer needs at least one department",
});

export const POST = route(async ({ user, request }) => {
  const body = await parseBody(request, schema);
  return transferBudget(user, {
    fromDepartmentId: body.from_department_id,
    toDepartmentId: body.to_department_id,
    amountPaise: body.amount_paise,
    reason: body.reason,
  });
}, { idempotent: true });
