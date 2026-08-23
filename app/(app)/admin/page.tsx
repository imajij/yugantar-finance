import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, expenseTypes, fests } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listUsers } from "@/lib/services/admin";
import { thresholdsFrom } from "@/lib/flags/types";
import { Card, PageTitle } from "@/components/ui";
import { ExpenseTypes, People, Thresholds } from "./panels";

export default async function AdminPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "user.manage", { festId: user.festId })) nf();

  const [people, depts, types, [fest]] = await Promise.all([
    listUsers(user),
    db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
    db
      .select()
      .from(expenseTypes)
      .where(eq(expenseTypes.festId, user.festId))
      .orderBy(asc(expenseTypes.sortOrder), asc(expenseTypes.name)),
    db.select().from(fests).where(eq(fests.id, user.festId)).limit(1),
  ]);

  return (
    <>
      <PageTitle>Admin</PageTitle>

      <Card>
        <h2 className="font-display text-sm">People</h2>
        <p className="mt-1 text-xs text-text-muted">
          A fest has exactly one Finance HOD and one Management account. Deactivating someone keeps
          their history; it only stops them signing in.
        </p>
        <People users={people} departments={depts} meId={user.id} />
      </Card>

      <Card className="mt-4">
        <h2 className="font-display text-sm">Expense types</h2>
        <ExpenseTypes types={types} />
      </Card>

      {can(user, "fest.manage", { festId: user.festId }) && (
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
