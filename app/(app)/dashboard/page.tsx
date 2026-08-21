import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { departmentTotals, departmentTotalsForFest, festTotals } from "@/lib/queries/budget";
import { utilizationPct } from "@/lib/money";
import { Amount, Card, Empty, PageTitle, StatCard, UtilizationBar } from "@/components/ui";

/** PRD 9 — Finance and Management get the fest overview; HODs and Members their department. */
export default async function DashboardPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const festWide = can(user, "income.view", scope); // Finance HOD and Management (5.1)

  return festWide ? <FestOverview festId={user.festId} /> : <DepartmentOverview departmentId={user.departmentId} name={user.departmentName} />;
}

async function FestOverview({ festId }: { festId: string }) {
  const totals = await festTotals(festId);
  if (!totals) return <Empty>No fest data yet. Run the seed.</Empty>;

  const rows = await db
    .select({ id: departments.id, name: departments.name, kind: departments.kind })
    .from(departments)
    .where(and(eq(departments.festId, festId), eq(departments.isActive, true)))
    .orderBy(asc(departments.name));
  const byDept = new Map((await departmentTotalsForFest(festId)).map((t) => [t.departmentId, t]));

  return (
    <>
      <PageTitle>Fest overview</PageTitle>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total budget" paise={totals.totalBudgetPaise} />
        <StatCard label="Allocated" paise={totals.allocatedPaise} hint="Across all departments" />
        <StatCard label="Reserve" paise={totals.reservePaise} />
        <StatCard label="Spent" paise={totals.spentPaise} tone="done" />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Pending" paise={totals.pendingPaise} tone="waiting" hint="Awaiting a decision" />
        <StatCard label="Committed" paise={totals.committedPaise} tone="decided" hint="Approved, not yet paid" />
        <StatCard
          label="Cash position"
          paise={totals.cashPositionPaise}
          hint="Income received − spent"
        />
        <StatCard
          label="Projected close"
          paise={totals.projectedClosePaise}
          hint="Expected − spent − committed − pending"
        />
      </div>

      <h2 className="font-display mt-10 mb-3 text-lg">Departments</h2>
      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 text-right font-medium">Allocated</th>
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
                    {d.kind !== "BUDGET" && <span className="ml-2 text-xs text-text-muted">{d.kind.toLowerCase()}</span>}
                  </td>
                  <td className="px-4 py-3 text-right"><Amount paise={t.allocatedPaise} /></td>
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

async function DepartmentOverview({ departmentId, name }: { departmentId: string; name: string }) {
  const t = await departmentTotals(departmentId);
  if (!t) return <Empty>This department has no budget yet.</Empty>;

  return (
    <>
      <PageTitle>{name}</PageTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Allocated" paise={t.allocatedPaise} />
        <StatCard label="Pending" paise={t.pendingPaise} tone="waiting" />
        <StatCard label="Committed" paise={t.committedPaise} tone="decided" />
        <StatCard label="Spent" paise={t.spentPaise} tone="done" />
        <StatCard label="Available" paise={t.availablePaise} hint="Allocated − pending − committed − spent" />
      </div>
      <p className="mt-4 text-sm text-text-muted">
        Pending is subtracted from Available, so money already in the approval queue cannot be spent twice.
      </p>
      <Link href={`/budget/${departmentId}`} className="mt-6 inline-block text-sm" style={{ color: "var(--yg-pink)" }}>
        See line items →
      </Link>
    </>
  );
}
