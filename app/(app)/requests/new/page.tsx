import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, expenseTypes, fests, lineItems } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can, canFestWide } from "@/lib/authz";
import { lineItemTotalsForDepartment, lineItemTotalsForFest } from "@/lib/queries/budget";
import { NewRequestForm } from "./form";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PRD 9 — mobile-first, camera capture, showing Available per line item so nobody overspends. */
export default async function NewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ department?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  const { department } = await searchParams;

  /*
   * Finance and Management may charge a claim to any department's line item
   * (`lineItem.spendAgainst`) — their own departments hold no budget, and Finance
   * records expenses on other departments' behalf. Everybody else charges their own.
   * The claim still goes to the charged department's head to endorse (7.2).
   */
  const anyDepartment = canFestWide(user, "lineItem.spendAgainst");
  // Opened from Department expenses for one department: offer only its line items.
  // Still fest-scoped below, so a department from another fest matches nothing.
  const forDepartment = anyDepartment && department && UUID.test(department) ? department : null;

  const [items, types, [fest]] = await Promise.all([
    db.select({
      id: lineItems.id, name: lineItems.name, plannedPaise: lineItems.plannedPaise,
      defaultExpenseTypeId: lineItems.defaultExpenseTypeId, departmentName: departments.name,
    }).from(lineItems)
      .innerJoin(departments, eq(departments.id, lineItems.departmentId))
      .where(and(
        eq(lineItems.festId, user.festId),
        forDepartment ? eq(lineItems.departmentId, forDepartment)
          : anyDepartment ? undefined : eq(lineItems.departmentId, user.departmentId),
        eq(lineItems.status, "OPEN"),
        isNull(lineItems.deletedAt),
      )).orderBy(asc(departments.name), asc(lineItems.name)),
    db.select().from(expenseTypes).where(and(
      eq(expenseTypes.festId, user.festId), eq(expenseTypes.isActive, true),
    )).orderBy(asc(expenseTypes.sortOrder)),
    db.select({ start: fests.receiptWindowStart, end: fests.receiptWindowEnd }).from(fests).where(eq(fests.id, user.festId)),
  ]);

  // A Member picks which pot a receipt is charged to without being shown what is
  // in it (5.1). The figures are simply not fetched for them, so there is nothing
  // to leak into the page — the choice is by name.
  const showsBudget = anyDepartment
    ? canFestWide(user, "lineItem.view")
    : can(user, "lineItem.view", { festId: user.festId, departmentId: user.departmentId });
  const totals = showsBudget
    ? new Map((anyDepartment
      ? await lineItemTotalsForFest(user.festId)
      : await lineItemTotalsForDepartment(user.departmentId)).map((t) => [t.lineItemId, t]))
    : new Map();

  // No PageTitle: the form carries its own header with the step counter, because on
  // a phone the page title and the step indicator competing for the top of the
  // screen costs the camera its space.
  return (
    <NewRequestForm
      showsBudget={showsBudget}
      anyDepartment={anyDepartment}
      forDepartment={forDepartment ? (items[0]?.departmentName ?? null) : null}
      lineItems={items.map((i) => {
        const t = totals.get(i.id);
        return {
          id: i.id,
          name: i.name,
          departmentName: i.departmentName,
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
