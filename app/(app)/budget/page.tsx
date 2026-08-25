import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can, canFestWide } from "@/lib/authz";
import { departmentTotalsForFest, festTotals } from "@/lib/queries/budget";
import { utilizationPct } from "@/lib/money";
import { Amount, Card, PageTitle, StatCard, UtilizationBar } from "@/components/ui";
import { Allocate } from "./allocate";
import { DecideAllocation } from "./allocation-request";
import { listAllocationRequests } from "@/lib/services/allocations";
import { stalledStages } from "@/lib/queries/stalled";
import { StalledNotice } from "@/components/stalled";

/**
 * Finance, Management and administrators see every department; everyone else goes
 * straight to their own. Whoever may transfer also allocates from here.
 */
export default async function BudgetPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  // No department in the resource, so only fest-wide reach comes back true.
  const seesAll = canFestWide(user, "department.budget.view");
  if (!seesAll) redirect(`/budget/${user.departmentId}`);

  const canAllocate = can(user, "budget.transfer", { festId: user.festId });
  const canDecide = can(user, "allocationRequest.decide", { festId: user.festId });

  const [totals, rows, deptTotals, asks, stalled] = await Promise.all([
    festTotals(user.festId),
    db.select({ id: departments.id, name: departments.name, kind: departments.kind })
      .from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
    departmentTotalsForFest(user.festId),
    canDecide ? listAllocationRequests(user, { status: "PENDING" }) : Promise.resolve([]),
    stalledStages(user),
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

      {canAllocate && (
        <p className="mt-3 text-xs text-text-muted">
          Setting a department&rsquo;s budget moves the difference to or from Reserve, with the
          reason you give, and is recorded in the audit log. A department can never be taken below
          what it has already committed or spent.
        </p>
      )}

      <StalledNotice
        stages={stalled}
        canFix={can(user, "user.manage", { festId: user.festId })}
      />

      {asks.length > 0 && (
        <section className="mt-6">
          <h2 className="font-display mb-3 text-lg">
            Waiting on you
            <span className="tnum ml-2 text-sm text-text-muted">{asks.length}</span>
          </h2>
          <p className="mb-3 text-xs text-text-muted">
            Approving moves the difference from Reserve and records the transfer, in one step.
            The arithmetic is checked at the moment you approve, not when they asked — so a
            request raised last week can still be refused if the reserve has since gone.
          </p>
          <div className="space-y-2">
            {asks.map((a) => (
              <DecideAllocation
                key={String(a.id)}
                id={String(a.id)}
                departmentName={String(a.department_name)}
                requestedPaise={Number(a.requested_paise)}
                currentPaise={Number(a.allocated_now)}
                reason={String(a.reason)}
                requestedBy={String(a.requested_by_name)}
              />
            ))}
          </div>
        </section>
      )}

      <Card className="mt-6 overflow-x-auto p-0">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
              <th className="px-4 py-3 font-medium">Department</th>
              <th className="px-4 py-3 text-right font-medium">Allocated</th>
              {canAllocate && <th className="px-4 py-3 text-right font-medium"></th>}
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
                  {canAllocate && (
                    <td className="px-4 py-3 text-right align-top">
                      {/* Finance and Core hold no budget of their own — the roles hang
                          off them, and money lives in the departments that spend it. */}
                      {d.kind === "BUDGET" ? (
                        <Allocate
                          departmentId={d.id}
                          departmentName={d.name}
                          allocatedPaise={t.allocatedPaise}
                          reservePaise={totals?.reservePaise ?? 0}
                        />
                      ) : (
                        <span className="text-xs text-text-muted">&mdash;</span>
                      )}
                    </td>
                  )}
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
