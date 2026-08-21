import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { AlertTriangle, CheckCircle2, FileText, Link2 } from "lucide-react";
import { db } from "@/db";
import { attachments, departments, fests, lineItems } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { departmentTotals, lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { formatPaise, utilizationPct } from "@/lib/money";
import { Amount, Card, Empty, PageTitle, StateChip, StatCard, UtilizationBar } from "@/components/ui";

interface Settings { line_item_doc_threshold_paise?: number }

export default async function DepartmentBudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const [dept] = await db.select().from(departments)
    .where(and(eq(departments.id, id), eq(departments.festId, user.festId))).limit(1);
  if (!dept) notFound();
  if (!can(user, "department.budget.view", { festId: user.festId, departmentId: dept.id })) notFound();

  const [fest] = await db.select({ settings: fests.settings }).from(fests).where(eq(fests.id, user.festId));
  const threshold = (fest?.settings as Settings)?.line_item_doc_threshold_paise ?? 0;

  const [totals, items] = await Promise.all([
    departmentTotals(dept.id),
    db.select().from(lineItems)
      .where(and(eq(lineItems.departmentId, dept.id), isNull(lineItems.deletedAt)))
      .orderBy(asc(lineItems.name)),
  ]);
  const byItem = new Map((await lineItemTotalsForDepartment(dept.id)).map((t) => [t.lineItemId, t]));

  const docs = items.length
    ? await db.select().from(attachments).where(and(
        eq(attachments.entityType, "LINE_ITEM"),
        inArray(attachments.entityId, items.map((i) => i.id)),
        isNull(attachments.removedAt),
      ))
    : [];

  const editable = can(user, "lineItem.edit", { festId: user.festId, departmentId: dept.id });
  const buffer = (totals?.allocatedPaise ?? 0) - (totals?.plannedPaise ?? 0);

  return (
    <>
      <PageTitle>{dept.name}</PageTitle>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Allocated" paise={totals?.allocatedPaise ?? 0} />
        <StatCard label="Pending" paise={totals?.pendingPaise ?? 0} tone="waiting" hint="Awaiting a decision" />
        <StatCard label="Committed" paise={totals?.committedPaise ?? 0} tone="decided" hint="Approved, unpaid" />
        <StatCard label="Spent" paise={totals?.spentPaise ?? 0} tone="done" />
        <StatCard label="Available" paise={totals?.availablePaise ?? 0} />
      </div>

      <p className="mt-3 text-sm text-text-muted">
        Planned across line items <Amount paise={totals?.plannedPaise ?? 0} />
        {" · "}unplanned buffer <Amount paise={buffer} />
        {" · "}utilization {utilizationPct(totals?.committedPaise ?? 0, totals?.spentPaise ?? 0, totals?.allocatedPaise ?? 0).toFixed(0)}%
      </p>

      <h2 className="font-display mt-8 mb-3 text-lg">Line items</h2>

      {items.length === 0 ? (
        <Empty>
          No line items yet.{" "}
          {editable ? "Break the allocation down so requests have somewhere to attach." : "The department HOD has not broken the allocation down yet."}
        </Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[54rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                <th className="px-4 py-3 font-medium">Line item</th>
                <th className="px-4 py-3 font-medium">Support</th>
                <th className="px-4 py-3 text-right font-medium">Planned</th>
                <th className="px-4 py-3 text-right font-medium">Pending</th>
                <th className="px-4 py-3 text-right font-medium">Committed</th>
                <th className="px-4 py-3 text-right font-medium">Spent</th>
                <th className="px-4 py-3 text-right font-medium">Available</th>
                <th className="px-4 py-3 font-medium">Used</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const t = byItem.get(i.id);
                const mine = docs.filter((d) => d.entityId === i.id);
                const quotes = mine.map((d) => d.quotedAmountPaise).filter((q): q is number => q != null);
                const lowest = quotes.length ? Math.min(...quotes) : null;
                // F13: at or above the threshold with no supporting document.
                const missingSupport = threshold > 0 && i.plannedPaise >= threshold && mine.length === 0;
                return (
                  <tr key={i.id} style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                    <td className="px-4 py-3">
                      <Link href={`/budget/${dept.id}/line-items/${i.id}`} className="hover:text-lime">{i.name}</Link>
                      {i.status === "CLOSED" && <span className="ml-2"><StateChip state="CLOSED" /></span>}
                      {i.description && <p className="mt-0.5 text-xs text-text-muted">{i.description}</p>}
                    </td>
                    <td className="px-4 py-3">
                      {missingSupport ? (
                        <span className="flex items-center gap-1.5 text-xs" style={{ color: "var(--flag-medium-fg)" }}>
                          <AlertTriangle size={13} aria-hidden /> No document
                        </span>
                      ) : mine.length > 0 ? (
                        <span className="flex items-center gap-1.5 text-xs text-text-muted">
                          {mine.some((d) => d.kind === "LINK") ? <Link2 size={13} aria-hidden /> : <FileText size={13} aria-hidden />}
                          {mine.length} {mine.length === 1 ? "quote" : "quotes"}
                          {lowest !== null && <span className="tnum">· low {formatPaise(lowest)}</span>}
                        </span>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                      {i.reviewedAt && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: "var(--state-done-fg)" }}>
                          <CheckCircle2 size={12} aria-hidden /> Reviewed
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right"><Amount paise={i.plannedPaise} /></td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--state-waiting-fg)" }}><Amount paise={t?.pendingPaise ?? 0} /></td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--state-decided-fg)" }}><Amount paise={t?.committedPaise ?? 0} /></td>
                    <td className="px-4 py-3 text-right" style={{ color: "var(--state-done-fg)" }}><Amount paise={t?.spentPaise ?? 0} /></td>
                    <td className="px-4 py-3 text-right"><Amount paise={t?.availablePaise ?? i.plannedPaise} /></td>
                    <td className="px-4 py-3">
                      <UtilizationBar pct={utilizationPct(t?.committedPaise ?? 0, t?.spentPaise ?? 0, i.plannedPaise)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
