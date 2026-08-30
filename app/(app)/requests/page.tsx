import Link from "next/link";
import { Camera, Receipt, Sheet } from "lucide-react";
import { redirect } from "next/navigation";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Plus } from "lucide-react";
import { db } from "@/db";
import { departments, lineItems, reimbursementRequests, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { canFestWide } from "@/lib/authz";
import { Amount, buttonClass, buttonStyle, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { waitingOn } from "@/lib/services/reimbursements";

/** Kept out of the JSX so the download reads as one thing in one place. */
const EXCEL_HREF = "/api/v1/exports/reimbursements?format=xlsx";

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
          <div className="flex items-center gap-2">
            {/*
              Whatever this screen is showing you, as a spreadsheet. The file is
              scoped by the same rule the list is (`reimbursementScope`), so it is
              never a way to take away more than the page in front of you.

              An `<a>`, because this is a download and not a navigation: `Link`
              would client-side route to it and the browser would never be handed
              the attachment.
            */}
            {rows.length > 0 && (
              <a
                href={EXCEL_HREF}
                className="flex items-center gap-1.5 rounded-full px-3.5 py-2 text-sm"
                style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
              >
                <Sheet size={15} aria-hidden /> Excel
              </a>
            )}
            <Link
              href="/requests/new"
              className="flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium"
              style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
            >
              <Plus size={15} aria-hidden /> New request
            </Link>
          </div>
        }
      >
        {seesAll ? "Reimbursements" : user.role === "DEPT_HOD" ? `${user.departmentName} reimbursements` : "My requests"}
      </PageTitle>

      {rows.length === 0 ? (
        <Empty
          icon={<Receipt size={24} aria-hidden />}
          title="No reimbursements yet"
          action={
            <Link href="/requests/new" className={buttonClass()} style={buttonStyle("primary")}>
              <Camera size={16} aria-hidden /> Photograph a receipt
            </Link>
          }
        >
          When you pay for something out of pocket, photograph the receipt here and your HOD
          sees it within minutes. Nothing is spent from your department&rsquo;s budget until
          Finance approves it.
        </Empty>
      ) : (
        /*
         * A list of rows, not a table. Seven columns is 870px of row, and this is
         * the screen a Member opens on a phone to see whether their claim moved —
         * the answer should not be behind a sideways swipe.
         */
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <Link
              key={r.id}
              href={`/requests/${r.id}`}
              className="flex flex-col gap-3 rounded-[var(--r-card)] p-4 hover:border-accent sm:flex-row sm:items-center sm:gap-4"
              style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tnum text-[11.5px] text-text-muted">{r.humanId}</span>
                  <StateChip state={r.status} />
                  {r.flagCount > 0 && (
                    <FlagChip severity={r.highFlags > 0 ? "HIGH" : "MEDIUM"}>
                      {r.flagCount} flag{r.flagCount === 1 ? "" : "s"}
                    </FlagChip>
                  )}
                </div>
                <span className="text-[14px]">{r.description}</span>
                <span className="text-[12px] text-text-muted">
                  {r.department} · {r.lineItem}
                  {seesAll && ` · ${r.submitter}`}
                </span>
              </div>

              <div className="flex items-center justify-between gap-4 sm:flex-col sm:items-end sm:gap-1.5">
                <span className="tnum text-[15px]"><Amount paise={r.amountPaise} /></span>
                <span className="flex items-center gap-2 text-[12px] text-text-muted">
                  {waitingOn(r.status, r.submitterRole)}
                  <Age days={r.ageDays} status={r.status} />
                </span>
              </div>
            </Link>
          ))}
        </div>
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
