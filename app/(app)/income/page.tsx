import { notFound as nf, redirect } from "next/navigation";
import { HandCoins } from "lucide-react";
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
      <div className="flex flex-col gap-2.5">
        {cashByType.map((t) => (
          <div
            key={t.type}
            className="flex flex-col gap-3 rounded-[var(--r-card)] p-4 sm:flex-row sm:items-center sm:gap-4"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
          >
            <span className="min-w-0 flex-1 text-[14px]">{TYPE_LABEL[t.type] ?? t.type}</span>
            <div className="grid grid-cols-3 gap-4 sm:w-[320px] sm:shrink-0">
              <Figure label="Pledged" paise={t.pledgedPaise} />
              <Figure label="Received" paise={t.receivedPaise} tone="var(--yg-accent)" />
              <Figure label="Expected" paise={t.expectedPaise} tone="var(--yg-accent)" />
            </div>
          </div>
        ))}

        {inKind && (
          <div
            className="flex flex-col gap-3 rounded-[var(--r-card)] p-4 sm:flex-row sm:items-center sm:gap-4"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
          >
            <span className="min-w-0 flex-1 text-[14px] text-text-muted">
              {TYPE_LABEL.SPONSORSHIP_IN_KIND}
              <span className="ml-2 text-[11.5px]">excluded from cash</span>
            </span>
            <div className="grid grid-cols-3 gap-4 sm:w-[320px] sm:shrink-0">
              <Figure label="Pledged" paise={inKind.pledgedPaise} />
              <Figure label="Received" paise={inKind.receivedPaise} />
              <span className="flex flex-col gap-0.5 sm:text-right">
                <span className="text-[11px] text-text-muted">Expected</span>
                <span className="text-[13.5px] text-text-muted">&mdash;</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {canManage && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Record income</h2>
          <NewIncomeForm departments={depts} />
        </Card>
      )}

      <h2 className="font-display mt-8 mb-3 text-lg">Ledger</h2>
      {ledger.length === 0 ? (
        <Empty icon={<HandCoins size={24} aria-hidden />} title="No income recorded yet">
          Sponsorships and ticket sales are recorded here as they are pledged and again as
          they arrive. Until then the fest&rsquo;s cash position is what has been spent, with
          nothing on the other side of it.
        </Empty>
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
                  <p><Amount paise={e.receivedPaise} className="text-accent" /> of <Amount paise={e.pledgedPaise} /></p>
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

/** A labelled amount — the label is what a table head used to carry. */
function Figure({ label, paise, tone }: { label: string; paise: number; tone?: string }) {
  return (
    <span className="flex flex-col gap-0.5 sm:text-right">
      <span className="text-[11px] text-text-muted">{label}</span>
      <span className="tnum text-[13.5px]" style={{ color: tone }}>
        <Amount paise={paise} />
      </span>
    </span>
  );
}
