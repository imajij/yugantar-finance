import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { AlertTriangle, CheckCircle2, ChevronRight, FileText, Link2, ListChecks } from "lucide-react";
import { db } from "@/db";
import { attachments, departments, expenseTypes, fests, lineItems } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { departmentTotals, lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { formatPaise } from "@/lib/money";
import { Empty, SectionHeading, StateChip } from "@/components/ui";
import { AvailableHero, availableTone, AvailableInline, DerivationLegend } from "@/components/five-numbers";
import { LineItemActions, NewLineItem } from "./line-items";
import { RaiseConcern } from "@/components/raise-flag";
import { AskForBudget } from "../allocation-request";
import { pendingFor } from "@/lib/services/allocations";
import { chargedCountsForDepartment } from "@/lib/services/line-items";

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
  const creatable = can(user, "lineItem.create", { festId: user.festId, departmentId: dept.id });
  // Deleting is offered for the ones nothing is filed against; the rest are closed,
  // not deleted, which is what `deleteLineItem` refuses them with.
  const removable = can(user, "lineItem.delete", { festId: user.festId, departmentId: dept.id });
  const charged = removable && items.length
    ? await chargedCountsForDepartment(dept.id, user.festId)
    : new Map<string, number>();
  const buffer = (totals?.allocatedPaise ?? 0) - (totals?.plannedPaise ?? 0);

  // An HOD drives their own budget's size by asking; only Finance and
  // administrators can actually move it (see `allocation-request.tsx`).
  const canAsk = can(user, "allocationRequest.create", { festId: user.festId, departmentId: dept.id });
  const ask = canAsk ? await pendingFor(user, dept.id) : null;

  const types = creatable || editable
    ? await db.select({ id: expenseTypes.id, name: expenseTypes.name }).from(expenseTypes)
        .where(and(eq(expenseTypes.festId, user.festId), eq(expenseTypes.isActive, true)))
        .orderBy(asc(expenseTypes.sortOrder), asc(expenseTypes.name))
    : [];

  const five = {
    allocatedPaise: totals?.allocatedPaise ?? 0,
    pendingPaise: totals?.pendingPaise ?? 0,
    committedPaise: totals?.committedPaise ?? 0,
    spentPaise: totals?.spentPaise ?? 0,
    availablePaise: totals?.availablePaise ?? 0,
  };
  const open = items.filter((i) => i.status === "OPEN").length;

  return (
    <>
      <p className="mb-3 flex items-center gap-2 text-[12.5px] text-text-muted">
        <Link href="/budget" style={{ color: "var(--yg-accent)" }}>Budget</Link>
        <ChevronRight size={13} aria-hidden />
        {dept.name}
      </p>

      <AvailableHero
        label={`${dept.name} · available`}
        totals={five}
        caption={
          five.pendingPaise > 0
            ? `${formatPaise(five.pendingPaise)} of that is held back for requests awaiting a decision`
            : `of ${formatPaise(five.allocatedPaise)} allocated · ${formatPaise(buffer)} not yet planned`
        }
        action={
          <div className="flex flex-wrap items-center gap-2.5">
            <RaiseConcern
              entityType="DEPARTMENT"
              entityId={dept.id}
              label="Raise a concern"
              allowed={can(user, "flag.raise", { festId: user.festId, departmentId: user.departmentId })}
            />
            {creatable && (
              <NewLineItem
                departmentId={dept.id}
                expenseTypes={types}
                availableToPlanPaise={buffer}
                docThresholdPaise={threshold}
              />
            )}
          </div>
        }
      />

      <div className="mt-[var(--gap-section)]">
        <DerivationLegend totals={five} />
      </div>

      {canAsk && (
        <div className="mt-[var(--gap-section)]">
          <AskForBudget
            departmentId={dept.id}
            departmentName={dept.name}
            allocatedPaise={five.allocatedPaise}
            pending={ask && {
              id: ask.id,
              requestedPaise: ask.requestedPaise,
              reason: ask.reason,
              createdAt: ask.createdAt.toISOString(),
            }}
          />
        </div>
      )}

      <div className="mt-8 mb-3">
        <SectionHeading
          aside={
            <span className="text-[12.5px] text-text-muted">
              {open} open · {items.length - open} closed ·{" "}
              <span className="tnum">{formatPaise(totals?.plannedPaise ?? 0)}</span> planned
            </span>
          }
        >
          Line items
        </SectionHeading>
      </div>

      {items.length === 0 ? (
        <Empty
          icon={<ListChecks size={24} aria-hidden />}
          title="Nothing is planned yet"
          action={creatable
            ? <NewLineItem
                departmentId={dept.id}
                expenseTypes={types}
                availableToPlanPaise={buffer}
                docThresholdPaise={threshold}
              />
            : undefined}
        >
          A line item is the pot a receipt is charged against — &ldquo;Sound system&rdquo;,
          &ldquo;Stage truss&rdquo;. Until there is at least one,{" "}
          {creatable
            ? "nobody in this department can submit a claim."
            : "nobody in this department can submit a claim; ask your HOD to break the allocation down."}
        </Empty>
      ) : (
        <div className="flex flex-col gap-2.5">
          {items.map((i) => {
            const t = byItem.get(i.id);
            const mine = docs.filter((d) => d.entityId === i.id);
            const quotes = mine.map((d) => d.quotedAmountPaise).filter((q): q is number => q != null);
            const lowest = quotes.length ? Math.min(...quotes) : null;
            // F13: at or above the threshold with no supporting document.
            const missingSupport = threshold > 0 && i.plannedPaise >= threshold && mine.length === 0;
            const five = {
              allocatedPaise: i.plannedPaise,
              pendingPaise: t?.pendingPaise ?? 0,
              committedPaise: t?.committedPaise ?? 0,
              spentPaise: t?.spentPaise ?? 0,
              availablePaise: t?.availablePaise ?? i.plannedPaise,
            };

            return (
              <div
                key={i.id}
                className="grid grid-cols-1 items-center gap-3 rounded-[var(--r-card)] p-[15px_18px] sm:grid-cols-[1.6fr_1fr_1fr_auto] sm:gap-4"
                style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
              >
                <div className="flex min-w-0 flex-col gap-[7px]">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <Link
                      href={`/budget/${dept.id}/line-items/${i.id}`}
                      className="text-[14px] font-medium hover:text-accent"
                    >
                      {i.name}
                    </Link>
                    {i.status === "CLOSED" && <StateChip state="CLOSED" />}
                    {missingSupport && (
                      <span
                        className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
                        style={{ background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }}
                      >
                        <AlertTriangle size={11} aria-hidden /> no document
                      </span>
                    )}
                    {i.reviewedAt && (
                      <span
                        className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px]"
                        style={{ background: "var(--state-decided-bg)", color: "var(--state-decided-fg)" }}
                      >
                        <CheckCircle2 size={11} aria-hidden /> reviewed
                      </span>
                    )}
                    {mine.length > 0 && !missingSupport && (
                      <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                        {mine.some((d) => d.kind === "LINK") ? <Link2 size={11} aria-hidden /> : <FileText size={11} aria-hidden />}
                        {mine.length} {mine.length === 1 ? "quote" : "quotes"}
                        {lowest !== null && <span className="tnum">· low {formatPaise(lowest)}</span>}
                      </span>
                    )}
                  </div>
                  <div className="max-w-[240px]">
                    <AvailableInline totals={five} />
                  </div>
                  {i.description && <p className="text-[12px] text-text-muted">{i.description}</p>}
                </div>

                <div className="flex items-baseline justify-between gap-2 sm:block sm:text-right">
                  <span className="text-[11px] text-text-muted">available</span>
                  <span className="tnum block text-[14px]" style={{ color: availableTone(five) }}>
                    {formatPaise(five.availablePaise)}
                  </span>
                </div>
                <div className="flex items-baseline justify-between gap-2 sm:block sm:text-right">
                  <span className="text-[11px] text-text-muted">planned</span>
                  <span className="tnum block text-[14px] text-text-soft">{formatPaise(i.plannedPaise)}</span>
                </div>

                {editable && (
                  <LineItemActions
                    item={{
                      id: i.id, name: i.name, description: i.description,
                      plannedPaise: i.plannedPaise,
                      defaultExpenseTypeId: i.defaultExpenseTypeId,
                      status: i.status,
                    }}
                    expenseTypes={types}
                    deletable={removable && (charged.get(i.id) ?? 0) === 0}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
