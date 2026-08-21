import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { fests, users } from "@/db/schema";
import { can } from "@/lib/authz";
import { parseBody, route } from "@/lib/api";
import { recordAudit, snapshot } from "@/lib/services/audit";

/** PRD 20.3 — current user, role, department, fest, plus the `can` summary the UI uses. */
export const GET = route(async ({ user }) => {
  const [fest] = await db.select().from(fests).where(eq(fests.id, user.festId)).limit(1);
  const scope = { festId: user.festId, departmentId: user.departmentId };
  return {
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      department: { id: user.departmentId, name: user.departmentName, kind: user.departmentKind },
      upi_id: user.upiId,
    },
    fest: {
      id: fest.id, name: fest.name, slug: fest.slug,
      starts_on: fest.startsOn, ends_on: fest.endsOn,
      receipt_window_start: fest.receiptWindowStart, receipt_window_end: fest.receiptWindowEnd,
      total_budget_paise: fest.totalBudgetPaise,
      // Settings are Finance-only (20.4).
      settings: can(user, "fest.settings.view", scope) ? fest.settings : undefined,
    },
    can: {
      manage_fest: can(user, "fest.manage", scope),
      manage_users: can(user, "user.manage", scope),
      transfer_budget: can(user, "budget.transfer", scope),
      view_all_departments: can(user, "department.view", { festId: user.festId, departmentId: "*" }),
      approve_reimbursements: can(user, "reimbursement.approve", { ...scope, submitterId: "someone-else" }),
      record_payments: can(user, "reimbursement.recordPayment", { ...scope, submitterId: "someone-else" }),
      view_income: can(user, "income.view", scope),
      resolve_flags: can(user, "flag.resolve", scope),
      run_exports: can(user, "export.run", scope),
    },
  };
});

const patchSchema = z.object({
  upi_id: z.string().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/, "Not a valid UPI ID").nullish(),
  phone: z.string().max(20).nullish(),
  digest_opt_in: z.boolean().optional(),
});

export const PATCH = route(async ({ user, request }) => {
  const body = await parseBody(request, patchSchema);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, user.id)).limit(1);
    const [after] = await tx
      .update(users)
      .set({
        ...(body.upi_id !== undefined ? { upiId: body.upi_id } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
        ...(body.digest_opt_in !== undefined ? { digestOptIn: body.digest_opt_in } : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id))
      .returning();

    const fields = ["upiId", "phone", "digestOptIn"] as const;
    await recordAudit(tx, {
      festId: user.festId, entityType: "USER", entityId: user.id, actorId: user.id,
      action: "user.profile.update",
      before: snapshot(before, fields), after: snapshot(after, fields),
    });
    return { upi_id: after.upiId, phone: after.phone, digest_opt_in: after.digestOptIn };
  });
});
