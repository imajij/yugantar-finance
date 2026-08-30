import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can, canFestWide } from "@/lib/authz";
import { departmentTotalsForFest, festTotals } from "@/lib/queries/budget";
import { Amount, buttonClass, buttonStyle, Card, PageTitle, SectionHeading } from "@/components/ui";
import { AvailableHero, availableTone, DerivationBar } from "@/components/five-numbers";
import { formatPaise } from "@/lib/money";
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

  // A Member is not shown a budget at all (5.1), so this is not theirs — refused
  // here rather than by redirecting them into a department page that then 404s.
  if (!can(user, "department.budget.view", { festId: user.festId, departmentId: user.departmentId })) {
    notFound();
  }

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

  const fest = {
    allocatedPaise: totals?.allocatedPaise ?? 0,
    pendingPaise: deptTotals.reduce((n, t) => n + t.pendingPaise, 0),
    committedPaise: deptTotals.reduce((n, t) => n + t.committedPaise, 0),
    spentPaise: deptTotals.reduce((n, t) => n + t.spentPaise, 0),
    availablePaise: deptTotals.reduce((n, t) => n + t.availablePaise, 0),
  };
  const budgeted = rows.filter((d) => d.kind === "BUDGET").length;

  return (
    <>
      <PageTitle
        subtitle={
          <>
            {budgeted} {budgeted === 1 ? "department" : "departments"} ·{" "}
            <span className="tnum">{formatPaise(totals?.allocatedPaise ?? 0)}</span> allocated
            {asks.length > 0 && ` · ${asks.length} allocation ${asks.length === 1 ? "request" : "requests"} waiting`}
          </>
        }
        action={
          can(user, "budgetReview.view", { festId: user.festId }) && (
            <Link href="/budget/review" className={buttonClass()} style={buttonStyle("ghost")}>
              Review line items
            </Link>
          )
        }
      >
        Budget
      </PageTitle>

      {/*
        The fest's own five numbers, as one derived figure. Reserve sits beside it
        rather than inside it — it is money not yet given to anybody, which is a
        different fact from money a department has left.
      */}
      <div className="grid gap-[var(--gap-section)] lg:grid-cols-[1.5fr_1fr]">
        <AvailableHero
          label="Available across every department"
          totals={fest}
          caption={`of ${formatPaise(fest.allocatedPaise)} allocated to departments`}
        />
        <div className="flex flex-col gap-4">
          <Card tight>
            <p className="meta-label">Reserve</p>
            <p className="tnum mt-2.5 text-[26px] leading-none font-semibold">
              {formatPaise(totals?.reservePaise ?? 0)}
            </p>
            <p className="mt-2 text-[12px] text-text-muted">
              Unallocated, held by Finance. Every department&rsquo;s increase comes out of this.
            </p>
          </Card>
          <Card tight>
            <p className="meta-label">Fest total budget</p>
            <p className="tnum mt-2.5 text-[26px] leading-none font-semibold">
              {formatPaise(totals?.totalBudgetPaise ?? 0)}
            </p>
            {canAllocate && (
              <p className="mt-2 text-[12px] text-text-muted">
                Setting a department&rsquo;s budget moves the difference to or from Reserve, with the
                reason you give. A department can never go below what it has already committed or spent.
              </p>
            )}
          </Card>
        </div>
      </div>

      <StalledNotice
        stages={stalled}
        canFix={can(user, "user.manage", { festId: user.festId })}
        className="mt-[var(--gap-section)]"
      />

      {asks.length > 0 && (
        <section className="mt-[var(--gap-section)] flex flex-col gap-3">
          <SectionHeading
            aside={
              <span className="text-[12.5px] text-text-muted">
                Approving moves the difference from Reserve and records the transfer, in one step.
              </span>
            }
          >
            Waiting on you
          </SectionHeading>
          {asks.map((a) => (
            <DecideAllocation
              key={String(a.id)}
              id={String(a.id)}
              departmentName={String(a.department_name)}
              requestedPaise={Number(a.requested_paise)}
              currentPaise={Number(a.allocated_now)}
              reservePaise={totals?.reservePaise ?? 0}
              reason={String(a.reason)}
              requestedBy={String(a.requested_by_name)}
            />
          ))}
        </section>
      )}

      {/*
        A grid of rows rather than a table: each department is a card with its own
        answer — name, Available, and the bar it was derived from — so the phone
        gets the same information stacked instead of a 48rem scroll.
      */}
      <section className="mt-[var(--gap-section)] flex flex-col gap-2">
        <div
          className="hidden grid-cols-[2.1fr_1fr_1fr_1fr_1fr] gap-4 px-[18px] pb-2.5 lg:grid"
          style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <span className="meta-label">Department · available</span>
          <span className="meta-label text-right">Allocated</span>
          <span className="meta-label text-right" style={{ color: "var(--state-waiting-fg)" }}>Pending</span>
          <span className="meta-label text-right" style={{ color: "var(--state-decided-fg)" }}>Committed</span>
          <span className="meta-label text-right" style={{ color: "var(--state-done-fg)" }}>Spent</span>
        </div>

        {rows.map((d) => {
          const t = byDept.get(d.id);
          if (!t) return null;
          const holdsBudget = d.kind === "BUDGET";
          return (
            <div
              key={d.id}
              className="grid grid-cols-1 items-center gap-3 rounded-[var(--r-card)] px-[18px] py-3.5 lg:grid-cols-[2.1fr_1fr_1fr_1fr_1fr] lg:gap-4"
              style={{ background: "var(--yg-surface)" }}
            >
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <Link href={`/budget/${d.id}`} className="text-[14.5px] font-medium hover:text-accent">
                    {d.name}
                  </Link>
                  <span className="tnum text-[16px] font-semibold" style={{ color: availableTone(t) }}>
                    {formatPaise(t.availablePaise)}
                  </span>
                  {t.pendingPaise > 0 && (
                    <span
                      className="rounded-full px-2.5 py-0.5 text-[11px]"
                      style={{ background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }}
                    >
                      {formatPaise(t.pendingPaise)} held back
                    </span>
                  )}
                </div>
                <div className="max-w-[340px]">
                  <DerivationBar totals={t} height={7} />
                </div>
                {canAllocate && holdsBudget && (
                  <Allocate
                    departmentId={d.id}
                    departmentName={d.name}
                    allocatedPaise={t.allocatedPaise}
                    reservePaise={totals?.reservePaise ?? 0}
                  />
                )}
              </div>

              {/* Labelled on a phone, where there is no column head to read up to. */}
              <Figure label="Allocated" paise={t.allocatedPaise} />
              <Figure label="Pending" paise={t.pendingPaise} tone="var(--state-waiting-fg)" />
              <Figure label="Committed" paise={t.committedPaise} />
              <Figure label="Spent" paise={t.spentPaise} />
            </div>
          );
        })}
      </section>
    </>
  );
}

/** One of the four parts, labelled on a phone and column-aligned on a desk. */
function Figure({ label, paise, tone }: { label: string; paise: number; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 lg:block lg:text-right">
      <span className="text-[11.5px] text-text-muted lg:hidden">{label}</span>
      <span className="tnum text-[13.5px]" style={{ color: tone ?? "var(--yg-text-soft)" }}>
        <Amount paise={paise} />
      </span>
    </div>
  );
}
