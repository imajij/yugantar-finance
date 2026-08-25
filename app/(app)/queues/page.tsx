import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, lineItems, reimbursementRequests, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { lineItemTotalsForDepartment } from "@/lib/queries/budget";
import { Amount, Card, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { stalledStages } from "@/lib/queries/stalled";
import { StalledNotice } from "@/components/stalled";

/**
 * PRD 20.11 — one screen, three queues, whichever the caller owns:
 * endorsements (Dept HOD), approvals (Finance), payments (Management).
 * Flagged first, then oldest first.
 */
export default async function QueuesPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const queues: { title: string; hint: string; statuses: string[]; departmentScoped: boolean }[] = [];

  if (user.role === "DEPT_HOD") {
    queues.push({ title: "To endorse", hint: "Submitted by your department, waiting on you", statuses: ["SUBMITTED"], departmentScoped: true });
  }
  if (can(user, "reimbursement.approve", { ...scope, submitterId: "x" })) {
    queues.push({ title: "To approve", hint: "Endorsed and waiting on Finance", statuses: ["HOD_ENDORSED"], departmentScoped: false });
  }
  if (can(user, "reimbursement.recordPayment", { ...scope, submitterId: "x" })) {
    queues.push({ title: "To pay", hint: "Approved and waiting on a transfer", statuses: ["APPROVED"], departmentScoped: false });
    queues.push({ title: "On hold", hint: "Paused, waiting on Finance to resolve", statuses: ["ON_HOLD"], departmentScoped: false });
  }

  const stalled = await stalledStages(user);
  const canFix = can(user, "user.manage", { festId: user.festId });

  if (queues.length === 0) {
    return (
      <>
        <PageTitle>Queues</PageTitle>
        <Empty>Nothing waits on you. Queues appear here when your role owns a decision.</Empty>
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
  user, title, hint, statuses, departmentScoped,
}: {
  user: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  title: string; hint: string; statuses: string[]; departmentScoped: boolean;
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
        <Empty>Clear.</Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[50rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">What for</th>
                <th className="px-4 py-3 font-medium">Payee</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 text-right font-medium">Available after</th>
                <th className="px-4 py-3 font-medium">Flags</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const available = availability.get(r.lineItemId) ?? 0;
                // Pending and committed already count this request, so Available is the after figure.
                const short = available < 0;
                return (
                  <tr key={r.id} style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                    <td className="tnum px-4 py-3">
                      <Link href={`/requests/${r.id}`} className="hover:text-lime">{r.humanId}</Link>
                    </td>
                    <td className="px-4 py-3">
                      <span className="block">{r.description}</span>
                      <span className="block text-xs text-text-muted">
                        {r.submitter} · {r.department} · {r.lineItem}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="block">{r.payeeName}</span>
                      <span className="tnum block text-xs text-text-muted">{r.payeeUpiId}</span>
                    </td>
                    <td className="px-4 py-3 text-right"><Amount paise={r.amountPaise} /></td>
                    <td className="px-4 py-3 text-right" style={{ color: short ? "var(--flag-high-fg)" : undefined }}>
                      <Amount paise={available} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.flagCount > 0
                          ? <FlagChip severity={r.highFlags > 0 ? "HIGH" : "MEDIUM"}>{r.flagCount}</FlagChip>
                          : <span className="text-xs text-text-muted">—</span>}
                        <StateChip state={r.status} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}
