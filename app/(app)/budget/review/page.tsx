import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, lineItems } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { utilizationPct } from "@/lib/money";
import { Amount, Card, Empty, PageTitle, StateChip, UtilizationBar } from "@/components/ui";

/**
 * PRD 6.4 / 9.3 — Finance walks every department's line items once before the fest.
 * "Reviewed" is a mark on the line item, not a state; it exists so Finance can see
 * what it has and has not yet looked at.
 */
export default async function BudgetReviewPage({
  searchParams,
}: { searchParams: Promise<{ show?: string }> }) {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "budgetReview.view", { festId: user.festId })) nf();

  const showAll = (await searchParams).show === "all";

  const depts = await db
    .select({ id: departments.id, name: departments.name, allocatedPaise: departments.allocatedPaise })
    .from(departments)
    .where(and(
      eq(departments.festId, user.festId),
      eq(departments.isActive, true),
      sql`${departments.allocatedPaise} > 0`,
    ))
    .orderBy(asc(departments.name));

  const sections = await Promise.all(depts.map(async (d) => {
    const [items, totals] = await Promise.all([
      db.select().from(lineItems)
        .where(and(eq(lineItems.departmentId, d.id), isNull(lineItems.deletedAt)))
        .orderBy(asc(lineItems.name)),
      lineItemTotalsForDepartment(d.id),
    ]);
    const byId = new Map(totals.map((t) => [t.lineItemId, t]));
    const rows = items
      .map((i) => ({ ...i, totals: byId.get(i.id) }))
      .filter((i) => showAll || !i.reviewedAt);

    const planned = items.reduce((s, i) => s + i.plannedPaise, 0);
    return { dept: d, rows, planned, itemCount: items.length, unreviewed: items.filter((i) => !i.reviewedAt).length };
  }));

  const totalUnreviewed = sections.reduce((s, x) => s + x.unreviewed, 0);

  return (
    <>
      <PageTitle
        action={
          <Link
            href={showAll ? "/budget/review" : "/budget/review?show=all"}
            className="rounded-full px-4 py-2 text-sm"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {showAll ? "Unreviewed only" : "Show all"}
          </Link>
        }
      >
        Budget review
      </PageTitle>

      <p className="mb-6 text-sm text-text-soft">
        {totalUnreviewed === 0
          ? "Every line item has been reviewed."
          : `${totalUnreviewed} line item${totalUnreviewed === 1 ? "" : "s"} still to review.`}
      </p>

      <div className="space-y-8">
        {sections.map(({ dept, rows, planned, itemCount, unreviewed }) => (
          <section key={dept.id}>
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-lg">
                <Link href={`/budget/${dept.id}`} className="hover:text-lime">{dept.name}</Link>
              </h2>
              <p className="text-xs text-text-muted">
                <Amount paise={planned} /> planned across {itemCount} line item{itemCount === 1 ? "" : "s"}
                {" · "}
                <Amount paise={dept.allocatedPaise} /> allocated
                {unreviewed > 0 && ` · ${unreviewed} unreviewed`}
              </p>
            </div>

            {/* Planning more than the allocation is legal — it just cannot all be spent. */}
            {planned > dept.allocatedPaise && (
              <p className="mb-2 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--flag-med-bg)", color: "var(--flag-med-fg)" }}>
                Line items plan <Amount paise={planned - dept.allocatedPaise} /> more than this department is allocated.
              </p>
            )}

            {rows.length === 0 ? (
              <Empty>{showAll ? "No line items." : "All reviewed."}</Empty>
            ) : (
              <Card className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-text-muted">
                      <th className="px-4 py-3 font-medium">Line item</th>
                      <th className="px-4 py-3 text-right font-medium">Planned</th>
                      <th className="px-4 py-3 text-right font-medium">Spent</th>
                      <th className="px-4 py-3 text-right font-medium">Available</th>
                      <th className="px-4 py-3 font-medium">Used</th>
                      <th className="px-4 py-3 font-medium">Reviewed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((i) => (
                      <tr key={i.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                        <td className="px-4 py-3">
                          <Link href={`/budget/${dept.id}/line-items/${i.id}`} style={{ color: "var(--yg-pink)" }}>
                            {i.name}
                          </Link>
                          {i.status === "CLOSED" && <StateChip state={i.status} />}
                        </td>
                        <td className="px-4 py-3 text-right"><Amount paise={i.plannedPaise} /></td>
                        <td className="px-4 py-3 text-right"><Amount paise={i.totals?.spentPaise ?? 0} /></td>
                        <td className="px-4 py-3 text-right"><Amount paise={i.totals?.availablePaise ?? i.plannedPaise} /></td>
                        <td className="px-4 py-3">
                          <UtilizationBar pct={utilizationPct(i.totals?.committedPaise ?? 0, i.totals?.spentPaise ?? 0, i.plannedPaise)} />
                        </td>
                        <td className="px-4 py-3 text-xs text-text-muted">
                          {i.reviewedAt ? new Date(i.reviewedAt).toLocaleDateString("en-IN") : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        ))}
      </div>
    </>
  );
}
