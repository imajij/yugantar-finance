import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, expenseTypes, fests } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listUsers } from "@/lib/services/admin";
import { festTotals } from "@/lib/queries/budget";
import { thresholdsFrom } from "@/lib/flags/types";
import { Card, PageTitle } from "@/components/ui";
import { Departments, ExpenseTypes, FestBudget, Thresholds } from "./panels";

export const dynamic = "force-dynamic";

/**
 * PRD 9 (Finance HOD, "Admin") and 20.3–20.4.
 *
 * The order is the order a fest is actually set up in: settle the total, carve it
 * into departments, then invite the people who will spend it. A fresh deployment
 * lands here with two departments and one user, so the sequence matters.
 */
export default async function AdminPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "user.manage", { festId: user.festId })) nf();

  const managesFest = can(user, "fest.manage", { festId: user.festId });

  const [people, depts, types, [fest], totals] = await Promise.all([
    listUsers(user),
    // Deactivated departments stay listed so they can be brought back; the open-record
    // count is what the deactivate button warns about before it refuses.
    db
      .select({
        id: departments.id,
        name: departments.name,
        slug: departments.slug,
        kind: departments.kind,
        allocatedPaise: departments.allocatedPaise,
        isActive: departments.isActive,
        openRecords: sql<number>`(
          (select count(*) from line_items li
            where li.department_id = ${departments.id} and li.deleted_at is null and li.status = 'OPEN')
        + (select count(*) from reimbursement_requests r
            where r.department_id = ${departments.id} and r.deleted_at is null
              and r.status in ('DRAFT','SUBMITTED','HOD_ENDORSED','APPROVED','ON_HOLD','SENT_BACK'))
        + (select count(*) from vendor_requests vr
            where vr.department_id = ${departments.id} and vr.deleted_at is null
              and vr.status not in ('CLOSED','DECLINED','CANCELLED'))
        )`.mapWith(Number),
      })
      .from(departments)
      .where(eq(departments.festId, user.festId))
      // Budget departments first, then the two structural ones.
      .orderBy(sql`case kind when 'BUDGET' then 0 else 1 end`, asc(departments.name)),
    db
      .select()
      .from(expenseTypes)
      .where(eq(expenseTypes.festId, user.festId))
      .orderBy(asc(expenseTypes.sortOrder), asc(expenseTypes.name)),
    db.select().from(fests).where(eq(fests.id, user.festId)).limit(1),
    festTotals(user.festId),
  ]);

  return (
    <>
      <PageTitle>Admin</PageTitle>

      {managesFest && (
        <Card>
          <h2 className="font-display text-sm">Fest budget</h2>
          <p className="mt-1 text-xs text-text-muted">
            The one figure everything else is measured against. Changing it is logged with
            the reason you give.
          </p>
          <FestBudget
            totalBudgetPaise={totals?.totalBudgetPaise ?? 0}
            allocatedPaise={totals?.allocatedPaise ?? 0}
          />
        </Card>
      )}

      <Card className="mt-4">
        <h2 className="font-display text-sm">Departments</h2>
        <p className="mt-1 text-xs text-text-muted">
          Finance and Core are structural — one of each, and the roles hang off them. Everything
          else is a budget department you add here.
        </p>
        <Departments departments={depts} />
      </Card>

      {/*
        * People used to be a card here, under the fest budget and the department
        * list — the screen somebody opens weekly sitting beneath the ones they set
        * up once, and invisible in the sidebar, because you cannot navigate to a
        * card. It has its own page now.
        */}
      <Card className="mt-4">
        <h2 className="font-display text-sm">People</h2>
        <p className="mt-1 text-xs text-text-muted">
          Inviting, deactivating and moving people between departments happens on{" "}
          <Link href="/team" className="underline underline-offset-2" style={{ color: "var(--yg-pink)" }}>
            Team
          </Link>
          . <span className="tnum">{people.length}</span> {people.length === 1 ? "person" : "people"}{" "}
          in this fest.
        </p>
      </Card>

      <Card className="mt-4">
        <h2 className="font-display text-sm">Expense types</h2>
        <ExpenseTypes types={types} />
      </Card>

      {managesFest && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Flag thresholds</h2>
          <p className="mt-1 text-xs text-text-muted">
            Flags are advisory. These dials change when one is raised, never whether a request can
            move.
          </p>
          <Thresholds values={{ ...thresholdsFrom(fest?.settings) }} />
        </Card>
      )}
    </>
  );
}
