import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { expenseTypes, fests, lineItems } from "@/db/schema";
import { getSession } from "@/lib/session";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { PageTitle } from "@/components/ui";
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

  const totals = new Map((await lineItemTotalsForDepartment(user.departmentId)).map((t) => [t.lineItemId, t]));

  return (
    <div className="max-w-xl">
      <PageTitle>New reimbursement</PageTitle>
      <NewRequestForm
        lineItems={items.map((i) => ({
          id: i.id, name: i.name,
          availablePaise: totals.get(i.id)?.availablePaise ?? i.plannedPaise,
          defaultExpenseTypeId: i.defaultExpenseTypeId,
        }))}
        expenseTypes={types.map((t) => ({ id: t.id, name: t.name }))}
        defaults={{ payeeName: user.name, payeeUpiId: user.upiId ?? "" }}
        receiptWindow={{ start: fest.start, end: fest.end }}
      />
    </div>
  );
}
