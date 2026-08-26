import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { expenseTypes, fests, lineItems } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { NewRequestForm } from "./form";

/** PRD 9 — mobile-first, camera capture, showing Available per line item so nobody overspends. */
export default async function NewRequestPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const [items, types, [fest]] = await Promise.all([
    db.select().from(lineItems).where(and(
      eq(lineItems.departmentId, user.departmentId),
      eq(lineItems.status, "OPEN"),
      isNull(lineItems.deletedAt),
    )).orderBy(asc(lineItems.name)),
    db.select().from(expenseTypes).where(and(
      eq(expenseTypes.festId, user.festId), eq(expenseTypes.isActive, true),
    )).orderBy(asc(expenseTypes.sortOrder)),
    db.select({ start: fests.receiptWindowStart, end: fests.receiptWindowEnd }).from(fests).where(eq(fests.id, user.festId)),
  ]);

  // A Member picks which pot a receipt is charged to without being shown what is
  // in it (5.1). The figures are simply not fetched for them, so there is nothing
  // to leak into the page — the choice is by name.
  const showsBudget = can(user, "lineItem.view", {
    festId: user.festId, departmentId: user.departmentId,
  });
  const totals = showsBudget
    ? new Map((await lineItemTotalsForDepartment(user.departmentId)).map((t) => [t.lineItemId, t]))
    : new Map();

  // No PageTitle: the form carries its own header with the step counter, because on
  // a phone the page title and the step indicator competing for the top of the
  // screen costs the camera its space.
  return (
    <NewRequestForm
      showsBudget={showsBudget}
      lineItems={items.map((i) => {
        const t = totals.get(i.id);
        return {
          id: i.id,
          name: i.name,
          plannedPaise: showsBudget ? i.plannedPaise : 0,
          availablePaise: showsBudget ? (t?.availablePaise ?? i.plannedPaise) : 0,
          pendingPaise: showsBudget ? (t?.pendingPaise ?? 0) : 0,
          committedPaise: showsBudget ? (t?.committedPaise ?? 0) : 0,
          spentPaise: showsBudget ? (t?.spentPaise ?? 0) : 0,
          defaultExpenseTypeId: i.defaultExpenseTypeId,
        };
      })}
      expenseTypes={types.map((t) => ({ id: t.id, name: t.name }))}
      defaults={{
        payeeName: user.name,
        payeeUpiId: user.upiId ?? "",
        department: user.departmentName,
      }}
      receiptWindow={{ start: fest.start, end: fest.end }}
    />
  );
}
