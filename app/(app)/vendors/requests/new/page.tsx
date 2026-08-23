import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { lineItems, vendors } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { Empty, PageTitle } from "@/components/ui";
import { VendorRequestForm } from "./form";

export default async function NewVendorRequestPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "vendorRequest.create", { festId: user.festId, departmentId: user.departmentId })) nf();

  const [vendorList, items, totals] = await Promise.all([
    db.select({ id: vendors.id, name: vendors.name }).from(vendors)
      .where(and(eq(vendors.festId, user.festId), isNull(vendors.deletedAt)))
      .orderBy(asc(vendors.name)),
    db.select({ id: lineItems.id, name: lineItems.name }).from(lineItems)
      .where(and(
        eq(lineItems.festId, user.festId),
        eq(lineItems.departmentId, user.departmentId),
        ne(lineItems.status, "CLOSED"),
        isNull(lineItems.deletedAt),
      ))
      .orderBy(asc(lineItems.name)),
    lineItemTotalsForDepartment(user.departmentId),
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
      <PageTitle>New vendor payment request</PageTitle>
      <VendorRequestForm
        vendors={vendorList}
        lineItems={choices}
        canApprove={can(user, "vendorRequest.approve", { festId: user.festId, departmentId: user.departmentId })}
      />
    </div>
  );
}
