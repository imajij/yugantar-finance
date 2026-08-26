import Link from "next/link";
import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, lineItems, reimbursementRequests, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { Amount, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { stalledStages } from "@/lib/queries/stalled";
import { StalledNotice } from "@/components/stalled";
import { RecordPayment } from "./record-payment";

/**
 * PRD 20.11 — one screen, three queues, whichever the caller owns:
 * endorsements (Dept HOD), approvals (Finance), payments (Management).
 * Flagged first, then oldest first.
 */
export default async function QueuesPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const queues: {
    title: string; hint: string; statuses: string[]; departmentScoped: boolean;
    /** Only the payment queue carries the action that moves money out. */
    pays?: boolean;
  }[] = [];

  if (user.role === "DEPT_HOD") {
    queues.push({ title: "To endorse", hint: "Submitted by your department, waiting on you", statuses: ["SUBMITTED"], departmentScoped: true });
  }
  if (can(user, "reimbursement.approve", { ...scope, submitterId: "x" })) {
    queues.push({ title: "To approve", hint: "Endorsed and waiting on Finance", statuses: ["HOD_ENDORSED"], departmentScoped: false });
  }
  if (can(user, "reimbursement.recordPayment", { ...scope, submitterId: "x" })) {
    queues.push({
      title: "To pay", hint: "Approved and waiting on a transfer. Record each one as it leaves the bank.",
      statuses: ["APPROVED"], departmentScoped: false, pays: true,
    });
    queues.push({ title: "On hold", hint: "Paused, waiting on Finance to resolve", statuses: ["ON_HOLD"], departmentScoped: false });
  }

  const stalled = await stalledStages(user);
  const canFix = can(user, "user.manage", { festId: user.festId });

  if (queues.length === 0) {
    return (
      <>
        <PageTitle>Queues</PageTitle>
        <Empty icon={<ClipboardList size={24} aria-hidden />} title="Nothing waits on you">
          A queue appears here when your role owns a decision — endorsing your department&rsquo;s
          claims, approving them, or recording the payment. Yours owns none of those.
        </Empty>
        <StalledNotice stages={stalled} canFix={canFix} />
      </>
    );
  }

  return (
    <>
      <PageTitle>Queues</PageTitle>
      <StalledNotice stages={stalled} canFix={canFix} />
      <div className="mt-6 space-y-8">
        {queues.map((q) => (
          <Queue key={q.title} user={user} {...q} />
        ))}
      </div>
    </>
  );
}

async function Queue({
  user, title, hint, statuses, departmentScoped, pays,
}: {
  user: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  title: string; hint: string; statuses: string[]; departmentScoped: boolean; pays?: boolean;
}) {
  const rows = await db
    .select({
      id: reimbursementRequests.id,
      humanId: reimbursementRequests.humanId,
      status: reimbursementRequests.status,
      amountPaise: reimbursementRequests.amountPaise,
      description: reimbursementRequests.description,
      lineItemId: reimbursementRequests.lineItemId,
      departmentId: reimbursementRequests.departmentId,
      payeeName: reimbursementRequests.payeeName,
      payeeUpiId: reimbursementRequests.payeeUpiId,
      submittedAt: reimbursementRequests.submittedAt,
      submitter: users.name,
      department: departments.name,
      lineItem: lineItems.name,
      highFlags: sql<number>`(select count(*) from flags
        where flags.entity_type = 'REIMBURSEMENT' and flags.entity_id = ${reimbursementRequests.id}
          and flags.status = 'OPEN' and flags.severity = 'HIGH')`.mapWith(Number),
      flagCount: sql<number>`(select count(*) from flags
        where flags.entity_type = 'REIMBURSEMENT' and flags.entity_id = ${reimbursementRequests.id}
          and flags.status = 'OPEN')`.mapWith(Number),
    })
    .from(reimbursementRequests)
    .innerJoin(users, eq(users.id, reimbursementRequests.submitterId))
    .innerJoin(departments, eq(departments.id, reimbursementRequests.departmentId))
    .innerJoin(lineItems, eq(lineItems.id, reimbursementRequests.lineItemId))
    .where(and(
      eq(reimbursementRequests.festId, user.festId),
      isNull(reimbursementRequests.deletedAt),
      inArray(reimbursementRequests.status, statuses as never[]),
      departmentScoped ? eq(reimbursementRequests.departmentId, user.departmentId) : undefined,
      // Nobody decides on their own request (5.2) — keep it out of the queue entirely.
      sql`${reimbursementRequests.submitterId} <> ${user.id}`,
    ))
    .orderBy(desc(sql`(select count(*) from flags
      where flags.entity_type = 'REIMBURSEMENT' and flags.entity_id = ${reimbursementRequests.id}
        and flags.status = 'OPEN')`), asc(reimbursementRequests.submittedAt));

  // Available impact, so an HOD endorses knowing what it does to the line item (9).
  const deptIds = [...new Set(rows.map((r) => r.departmentId))];
  const availability = new Map<string, number>();
  for (const deptId of deptIds) {
    for (const t of await lineItemTotalsForDepartment(deptId)) availability.set(t.lineItemId, t.availablePaise);
  }

  return (
    <section>
      <h2 className="font-display text-lg">{title}</h2>
      <p className="mb-3 text-xs text-text-muted">{hint}</p>

      {rows.length === 0 ? (
        <Empty>Nothing is waiting on you here.</Empty>
      ) : (
        /*
         * Rows, not a table: this is the screen somebody works down while paying
         * eleven people from a banking app, and on a phone a 50rem table is not
         * something you can work down at all.
         */
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => {
            const available = availability.get(r.lineItemId) ?? 0;
            // Pending and committed already count this request, so Available is the after figure.
            const short = available < 0;
            return (
              <div
                key={r.id}
                className="flex flex-col gap-3 rounded-[var(--r-card)] p-4"
                style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/requests/${r.id}`} className="tnum text-[11.5px] text-text-muted hover:text-lime">
                        {r.humanId}
                      </Link>
                      <StateChip state={r.status} />
                      {r.flagCount > 0 && (
                        <FlagChip severity={r.highFlags > 0 ? "HIGH" : "MEDIUM"}>
                          {r.flagCount} flag{r.flagCount === 1 ? "" : "s"}
                        </FlagChip>
                      )}
                    </div>
                    <Link href={`/requests/${r.id}`} className="text-[14px] hover:text-lime">
                      {r.description}
                    </Link>
                    <span className="text-[12px] text-text-muted">
                      {r.submitter} · {r.department} · {r.lineItem}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 sm:shrink-0 sm:flex-col sm:items-end">
                    <span className="tnum text-[16px]"><Amount paise={r.amountPaise} /></span>
                    <span className="text-[12px] text-text-muted">
                      to {r.payeeName}
                      {r.payeeUpiId && <span className="tnum"> · {r.payeeUpiId}</span>}
                    </span>
                    <span className="text-[12px]" style={{ color: short ? "var(--flag-high-fg)" : "var(--yg-text-muted)" }}>
                      <Amount paise={available} /> left in the line item after this
                    </span>
                  </div>
                </div>

                {/*
                  The action, where the work is. PRD 9 asks for it here rather than
                  behind a click into each request — you are paying eleven people,
                  not reading eleven records.
                */}
                {pays && (
                  <div style={{ borderTop: "1px solid var(--yg-surface-2)", paddingTop: "12px" }}>
                    <RecordPayment
                      id={r.id}
                      humanId={r.humanId}
                      payeeName={r.payeeName}
                      payeeUpiId={r.payeeUpiId}
                      amountPaise={r.amountPaise}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
