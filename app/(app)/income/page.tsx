import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { followupDaysFor, incomeLedger } from "@/lib/services/income";
import { festTotals, incomeTotalsByType } from "@/lib/queries/budget";
import { Amount, Card, Empty, PageTitle, StatCard, StateChip } from "@/components/ui";
import { IncomeActions, NewIncomeForm } from "./actions";

const TYPE_LABEL: Record<string, string> = {
  SPONSORSHIP_CASH: "Sponsorship (cash)",
  SPONSORSHIP_IN_KIND: "Sponsorship (in kind)",
  EVENT_TICKETS: "Event tickets",
  COLLEGE_GRANT: "College grant",
  OTHER: "Other",
};

/**
 * PRD 9.6 / 20.8 — pledged versus received, with the gap made obvious.
 * In-kind is shown but excluded from the cash position, exactly as the view does it.
 */
export default async function IncomePage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "income.view", { festId: user.festId })) nf();

  const [ledger, byType, totals, depts, followupDays] = await Promise.all([
    incomeLedger(user),
    incomeTotalsByType(user.festId),
    festTotals(user.festId),
    db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
    followupDaysFor(user.festId),
  ]);

  const canManage = can(user, "income.manage", { festId: user.festId });
  const overdue = ledger.filter((e) => e.overdue);
  const cashByType = byType.filter((t) => t.type !== "SPONSORSHIP_IN_KIND");
  const inKind = byType.find((t) => t.type === "SPONSORSHIP_IN_KIND");

  return (
    <>
      <PageTitle>Income</PageTitle>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Received" paise={totals?.incomeReceivedPaise ?? 0} tone="done" hint="Cash in hand" />
        <StatCard label="Expected" paise={totals?.incomeExpectedPaise ?? 0} tone="waiting" hint="Everything pledged, if it all lands" />
        <StatCard label="Spent" paise={totals?.spentPaise ?? 0} hint="Paid out so far" />
        <StatCard
          label="Cash position" paise={totals?.cashPositionPaise ?? 0}
          tone={(totals?.cashPositionPaise ?? 0) < 0 ? "waiting" : "done"}
          hint="Received minus spent"
        />
      </div>

      {overdue.length > 0 && (
        <p className="mt-4 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-med-bg)", color: "var(--flag-med-fg)" }}>
          {overdue.length} pledge{overdue.length === 1 ? "" : "s"} unreceived more than {followupDays} days after
          being promised — <Amount paise={overdue.reduce((s, e) => s + e.outstandingPaise, 0)} /> outstanding.
        </p>
      )}

      <h2 className="font-display mt-8 mb-3 text-lg">By type</h2>
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 text-right font-medium">Pledged</th>
              <th className="px-4 py-3 text-right font-medium">Received</th>
              <th className="px-4 py-3 text-right font-medium">Expected</th>
            </tr>
          </thead>
          <tbody>
            {cashByType.map((t) => (
              <tr key={t.type} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                <td className="px-4 py-3">{TYPE_LABEL[t.type] ?? t.type}</td>
                <td className="px-4 py-3 text-right"><Amount paise={t.pledgedPaise} /></td>
                <td className="px-4 py-3 text-right"><Amount paise={t.receivedPaise} className="text-lime" /></td>
                <td className="px-4 py-3 text-right"><Amount paise={t.expectedPaise} className="text-yellow" /></td>
              </tr>
            ))}
            {inKind && (
              <tr style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                <td className="px-4 py-3 text-text-muted">
                  {TYPE_LABEL.SPONSORSHIP_IN_KIND}
                  <span className="ml-2 text-xs">excluded from cash</span>
                </td>
                <td className="px-4 py-3 text-right text-text-muted"><Amount paise={inKind.pledgedPaise} /></td>
                <td className="px-4 py-3 text-right text-text-muted"><Amount paise={inKind.receivedPaise} /></td>
                <td className="px-4 py-3 text-right text-text-muted">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {canManage && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Record income</h2>
          <NewIncomeForm departments={depts} />
        </Card>
      )}

      <h2 className="font-display mt-8 mb-3 text-lg">Ledger</h2>
      {ledger.length === 0 ? (
        <Empty>No income recorded yet.</Empty>
      ) : (
        <div className="space-y-2">
          {ledger.map((e) => (
            <Card key={e.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm text-text">{e.sourceName}</span>
                    <StateChip state={e.status} />
                    {e.overdue && (
                      <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--flag-med-bg)", color: "var(--flag-med-fg)" }}>
                        {e.daysSincePledge}d unreceived
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {TYPE_LABEL[e.type] ?? e.type}
                    {e.department ? ` · ${e.department}` : ""}
                    {e.pledgedOn ? ` · pledged ${e.pledgedOn}` : ""}
                  </p>
                  {e.writtenOffReason && (
                    <p className="mt-1 text-xs" style={{ color: "var(--state-bad-fg)" }}>
                      Written off: {e.writtenOffReason}
                    </p>
                  )}
                </div>
                <div className="text-right text-sm">
                  <p><Amount paise={e.receivedPaise} className="text-lime" /> of <Amount paise={e.pledgedPaise} /></p>
                  {e.outstandingPaise > 0 && e.status !== "WRITTEN_OFF" && (
                    <p className="text-xs text-text-muted"><Amount paise={e.outstandingPaise} /> outstanding</p>
                  )}
                </div>
              </div>
              {canManage && <IncomeActions id={e.id} status={e.status} outstandingPaise={e.outstandingPaise} />}
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
