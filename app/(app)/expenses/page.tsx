import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { FileText, Receipt, Truck } from "lucide-react";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { departmentsForExpenses, expensesAddedForOthers } from "@/lib/queries/department-expenses";
import {
  Amount, Card, Empty, PageTitle, SectionHeading, StateChip, buttonClass, buttonStyle,
} from "@/components/ui";

/**
 * Department expenses (PRD 9, Finance HOD).
 *
 * The Finance HOD's own department holds no budget, so nearly everything they
 * spend is on another department's behalf. This is where they do it: pick the
 * department, then add an expense claim or raise a vendor payment against its line
 * items. Both go through the ordinary flows — a claim is endorsed by that
 * department's head and approved by Management; a vendor request Finance raised it
 * may approve itself, with a note (5.2).
 */
export default async function DepartmentExpensesPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "expense.forAnyDepartment", { festId: user.festId })) notFound();

  const [departments, added] = await Promise.all([
    departmentsForExpenses(user),
    expensesAddedForOthers(user),
  ]);

  return (
    <>
      <PageTitle subtitle="Add an expense or a vendor payment to any department's budget.">
        Department expenses
      </PageTitle>

      {departments.length === 0 ? (
        <Empty icon={<Receipt size={24} aria-hidden />} title="No other departments yet">
          Add departments from Admin, and give them an allocation, before adding expenses to them.
        </Empty>
      ) : (
        <div className="flex flex-col gap-2.5">
          {departments.map((d) => (
            <Card key={d.id} tight className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link href={`/budget/${d.id}`} className="text-[14px] font-medium hover:underline">{d.name}</Link>
                <span className="text-[12px] text-text-muted">
                  <Amount paise={d.availablePaise} className="text-text-soft" /> available ·{" "}
                  {d.openLineItems === 1 ? "1 open line item" : `${d.openLineItems} open line items`}
                </span>
              </div>
              {d.openLineItems === 0 ? (
                <p className="text-[12px] text-text-muted sm:max-w-[30ch] sm:text-right">
                  Nothing to charge yet —{" "}
                  <Link href={`/budget/${d.id}`} className="underline">add a line item</Link> first.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Link
                    href={`/requests/new?department=${d.id}`}
                    className={buttonClass()}
                    style={buttonStyle("primary")}
                  >
                    <FileText size={15} aria-hidden /> Add expense
                  </Link>
                  <Link
                    href={`/vendors/requests/new?department=${d.id}`}
                    className={buttonClass()}
                    style={buttonStyle("ghost")}
                  >
                    <Truck size={15} aria-hidden /> Vendor payment
                  </Link>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <div className="mt-8 mb-3">
        <SectionHeading>Added by you</SectionHeading>
      </div>
      {added.length === 0 ? (
        <Empty>
          Expenses and vendor payments you add for other departments are listed here, with
          where each one stands.
        </Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {added.map((e) => (
            <Link
              key={e.id}
              href={e.kind === "REIMBURSEMENT" ? `/requests/${e.id}` : `/vendors/requests/${e.id}`}
              className="flex flex-col gap-1.5 rounded-[var(--r-card)] p-3.5 hover:border-accent sm:flex-row sm:items-center sm:gap-4"
              style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-[13.5px]">{e.description}</span>
                <span className="text-[12px] text-text-muted">
                  <span className="tnum">{e.humanId}</span> ·{" "}
                  {e.kind === "REIMBURSEMENT" ? "expense" : "vendor payment"} · {e.department}
                </span>
              </div>
              <div className="flex items-center gap-3 sm:shrink-0">
                <StateChip state={e.status} />
                <Amount paise={e.amountPaise} className="text-[13.5px]" />
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
