import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { departments, lineItems, vendors } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can, canFestWide } from "@/lib/authz";
import { lineItemTotalsForDepartment, lineItemTotalsForFest } from "@/lib/queries/budget";
import { Empty, PageTitle } from "@/components/ui";
import { VendorRequestForm } from "./form";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewVendorRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ department?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  const { department } = await searchParams;
  if (!can(user, "vendorRequest.create", { festId: user.festId, departmentId: user.departmentId })) nf();

  // Finance raises vendor requests for any department (`vendorRequest.create`); a
  // head raises them for their own.
  const anyDepartment = canFestWide(user, "vendorRequest.create");
  // Opened from Department expenses for one department: only its line items.
  const forDepartment = anyDepartment && department && UUID.test(department) ? department : null;

  const [vendorList, items, totals] = await Promise.all([
    db.select({ id: vendors.id, name: vendors.name }).from(vendors)
      .where(and(eq(vendors.festId, user.festId), isNull(vendors.deletedAt)))
      .orderBy(asc(vendors.name)),
    db.select({ id: lineItems.id, name: lineItems.name, departmentName: departments.name }).from(lineItems)
      .innerJoin(departments, eq(departments.id, lineItems.departmentId))
      .where(and(
        eq(lineItems.festId, user.festId),
        forDepartment ? eq(lineItems.departmentId, forDepartment)
          : anyDepartment ? undefined : eq(lineItems.departmentId, user.departmentId),
        ne(lineItems.status, "CLOSED"),
        isNull(lineItems.deletedAt),
      ))
      .orderBy(asc(departments.name), asc(lineItems.name)),
    anyDepartment ? lineItemTotalsForFest(user.festId) : lineItemTotalsForDepartment(user.departmentId),
  ]);

  const available = new Map(totals.map((t) => [t.lineItemId, t.availablePaise]));
  const choices = items.map((i) => ({ ...i, availablePaise: available.get(i.id) ?? 0 }));

  if (vendorList.length === 0) {
    return (
      <>
        <PageTitle>New vendor payment request</PageTitle>
        <Empty>Add a vendor first — a payment request has to point at one.</Empty>
      </>
    );
  }

  return (
    <div className="max-w-xl">
      <PageTitle subtitle={forDepartment && items[0] ? `Charged to ${items[0].departmentName}` : undefined}>
        New vendor payment request
      </PageTitle>
      <VendorRequestForm
        vendors={vendorList}
        lineItems={choices}
        anyDepartment={anyDepartment}
        canApprove={can(user, "vendorRequest.approve", { festId: user.festId, departmentId: user.departmentId })}
      />
    </div>
  );
}
