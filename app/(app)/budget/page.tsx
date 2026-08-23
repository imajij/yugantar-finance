import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { departmentTotalsForFest, festTotals } from "@/lib/queries/budget";
import { utilizationPct } from "@/lib/money";
import { Amount, Card, PageTitle, StatCard, UtilizationBar } from "@/components/ui";

/** Finance and Management see every department; everyone else goes straight to their own. */
export default async function BudgetPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const seesAll = can(user, "department.budget.view", { festId: user.festId, departmentId: "any-other" });
  if (!seesAll) redirect(`/budget/${user.departmentId}`);

  const [totals, rows, deptTotals] = await Promise.all([
    festTotals(user.festId),
    db.select({ id: departments.id, name: departments.name, kind: departments.kind })
      .from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
    departmentTotalsForFest(user.festId),
  ]);
  const byDept = new Map(deptTotals.map((t) => [t.departmentId, t]));

  return (
    <>
      <PageTitle
        action={
          can(user, "budgetReview.view", { festId: user.festId }) && (
            <Link
              href="/budget/review"
              className="rounded-full px-4 py-2 text-sm"
              style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
            >
              Review line items
            </Link>
          )
        }
      >
        Budget
      </PageTitle>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard label="Total budget" paise={totals?.totalBudgetPaise ?? 0} />
        <StatCard label="Allocated" paise={totals?.allocatedPaise ?? 0} />
        <StatCard label="Reserve" paise={totals?.reservePaise ?? 0} hint="Unallocated, held by Finance" />
      </div>

      <Card className="mt-6 overflow-x-auto p-0">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 text-right font-medium">Allocated</th>
              <th className="px-4 py-3 text-right font-medium">Planned</th>
              <th className="px-4 py-3 text-right font-medium">Pending</th>
              <th className="px-4 py-3 text-right font-medium">Committed</th>
              <th className="px-4 py-3 text-right font-medium">Spent</th>
              <th className="px-4 py-3 text-right font-medium">Available</th>
              <th className="px-4 py-3 font-medium">Utilization</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const t = byDept.get(d.id);
              if (!t) return null;
              return (
                <tr key={d.id} style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                  <td className="px-4 py-3">
                    <Link href={`/budget/${d.id}`} className="hover:text-lime">{d.name}</Link>
                  </td>
                  <td className="px-4 py-3 text-right"><Amount paise={t.allocatedPaise} /></td>
                  <td className="px-4 py-3 text-right text-text-muted"><Amount paise={t.plannedPaise} /></td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--state-waiting-fg)" }}><Amount paise={t.pendingPaise} /></td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--state-decided-fg)" }}><Amount paise={t.committedPaise} /></td>
                  <td className="px-4 py-3 text-right" style={{ color: "var(--state-done-fg)" }}><Amount paise={t.spentPaise} /></td>
                  <td className="px-4 py-3 text-right"><Amount paise={t.availablePaise} /></td>
                  <td className="px-4 py-3">
                    <UtilizationBar pct={utilizationPct(t.committedPaise, t.spentPaise, t.allocatedPaise)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </>
  );
}
