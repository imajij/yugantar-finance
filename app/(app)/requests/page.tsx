import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Plus } from "lucide-react";
import { db } from "@/db";
import { departments, lineItems, reimbursementRequests, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { canFestWide } from "@/lib/authz";
import { Amount, Card, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { waitingOn } from "@/lib/services/reimbursements";

export default async function RequestsPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const seesAll = canFestWide(user, "reimbursement.view");
  const scope = seesAll ? undefined
    : user.role === "DEPT_HOD" ? eq(reimbursementRequests.departmentId, user.departmentId)
    : eq(reimbursementRequests.submitterId, user.id);

  const rows = await db
    .select({
      id: reimbursementRequests.id,
      humanId: reimbursementRequests.humanId,
      status: reimbursementRequests.status,
      amountPaise: reimbursementRequests.amountPaise,
      description: reimbursementRequests.description,
      transactionOn: reimbursementRequests.transactionOn,
      submitter: users.name,
      submitterRole: users.role,
      department: departments.name,
      lineItem: lineItems.name,
      flagCount: sql<number>`(select count(*) from flags
        where flags.entity_type = 'REIMBURSEMENT' and flags.entity_id = ${reimbursementRequests.id}
          and flags.status = 'OPEN')`.mapWith(Number),
      highFlags: sql<number>`(select count(*) from flags
        where flags.entity_type = 'REIMBURSEMENT' and flags.entity_id = ${reimbursementRequests.id}
          and flags.status = 'OPEN' and flags.severity = 'HIGH')`.mapWith(Number),
      // Age comes from the database so rendering stays pure and the clock is the server's.
      ageDays: sql<number>`floor(extract(epoch from now() - ${reimbursementRequests.createdAt}) / 86400)`.mapWith(Number),
    })
    .from(reimbursementRequests)
    .innerJoin(users, eq(users.id, reimbursementRequests.submitterId))
    .innerJoin(departments, eq(departments.id, reimbursementRequests.departmentId))
    .innerJoin(lineItems, eq(lineItems.id, reimbursementRequests.lineItemId))
    .where(and(
      eq(reimbursementRequests.festId, user.festId),
      isNull(reimbursementRequests.deletedAt),
      scope,
    ))
    .orderBy(desc(reimbursementRequests.createdAt))
    .limit(100);

  return (
    <>
      <PageTitle
        action={
          <Link
            href="/requests/new"
            className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium"
            style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
          >
            <Plus size={15} aria-hidden /> New request
          </Link>
        }
      >
        {seesAll ? "Reimbursements" : user.role === "DEPT_HOD" ? `${user.departmentName} reimbursements` : "My requests"}
      </PageTitle>

      {rows.length === 0 ? (
        <Empty>Nothing here yet. Spent your own money on the fest? Raise a request.</Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[52rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                <th className="px-4 py-3 font-medium">ID</th>
                <th className="px-4 py-3 font-medium">What for</th>
                {seesAll && <th className="px-4 py-3 font-medium">Submitter</th>}
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Waiting on</th>
                <th className="px-4 py-3 font-medium">Age</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                  <td className="tnum px-4 py-3">
                    <Link href={`/requests/${r.id}`} className="hover:text-lime">{r.humanId}</Link>
                  </td>
                  <td className="px-4 py-3">
                    <span className="block">{r.description}</span>
                    <span className="block text-xs text-text-muted">{r.department} · {r.lineItem}</span>
                  </td>
                  {seesAll && <td className="px-4 py-3 text-text-soft">{r.submitter}</td>}
                  <td className="px-4 py-3 text-right"><Amount paise={r.amountPaise} /></td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StateChip state={r.status} />
                      {r.flagCount > 0 && (
                        <FlagChip severity={r.highFlags > 0 ? "HIGH" : "MEDIUM"}>
                          {r.flagCount} flag{r.flagCount === 1 ? "" : "s"}
                        </FlagChip>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-text-muted">{waitingOn(r.status, r.submitterRole)}</td>
                  <td className="px-4 py-3"><Age days={r.ageDays} status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/** 7.2 — amber after 3 days without action, red after 7. Terminal states don't age. */
function Age({ days, status }: { days: number; status: string }) {
  if (["PAID", "DECLINED", "WITHDRAWN"].includes(status)) return <span className="text-xs text-text-muted">—</span>;
  const color = days >= 7 ? "var(--state-bad-fg)" : days >= 3 ? "var(--state-waiting-fg)" : "var(--yg-text-muted)";
  return <span className="tnum text-xs" style={{ color }}>{days}d</span>;
}
