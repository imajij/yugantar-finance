import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listUsers } from "@/lib/services/admin";
import { Card, PageTitle } from "@/components/ui";
import { People } from "../admin/panels";

export const dynamic = "force-dynamic";

/**
 * People (PRD 5.1, 20.10). One page, two sizes.
 *
 * Finance gets the fest and every control: roles, departments, the administrator
 * flag. A department head gets their own department and the two things that are
 * theirs — who is in it, and who is not any more. What a head may not do is not
 * shown to them, and would be refused by `assertMayManage` if it were.
 *
 * It is its own page rather than a card on Admin because this is the screen
 * somebody opens weekly, and it was sitting underneath the ones you set up once —
 * invisible in the sidebar, because you cannot navigate to a card.
 */
export default async function TeamPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  const scope = { festId: user.festId, departmentId: user.departmentId };
  if (!can(user, "user.manageOwnTeam", scope)) nf();

  const festWide = can(user, "user.manage", { festId: user.festId });

  // Scoped by the service, not by anything this page passes — there is nothing
  // here a head could edit to widen it.
  const [people, depts] = await Promise.all([
    listUsers(user),
    festWide
      ? db.select({ id: departments.id, name: departments.name }).from(departments)
          .where(and(
            eq(departments.festId, user.festId),
            eq(departments.isActive, true),
          ))
          .orderBy(asc(departments.name))
      : Promise.resolve([]),
  ]);

  return (
    <>
      <PageTitle subtitle={`${people.length} ${people.length === 1 ? "person" : "people"}`}>
        {festWide ? "People" : user.departmentName}
      </PageTitle>

      <Card>
        <h2 className="font-display text-sm">{festWide ? "Everybody in the fest" : "Your team"}</h2>
        <p className="mt-1 text-xs text-text-muted">
          {festWide ? (
            <>
              Inviting someone emails them a sign-in link. A department can have as many heads as it
              needs — where it has more than one, a head&rsquo;s own claim is endorsed by one of the
              others rather than skipping the step. A fest has one Finance HOD and one Management
              account. Deactivating someone keeps their history, ends their sessions, and only stops
              them signing in.
            </>
          ) : (
            <>
              Adding someone emails them a sign-in link and puts them in your department&rsquo;s
              channel. Deactivating keeps everything they filed, ends their sessions, and takes them
              out of the channel — it is how somebody leaves, not how their history does. Roles and
              departments are Finance&rsquo;s to set; ask them if somebody needs to move or step up.
            </>
          )}
        </p>
        <People
          users={people}
          departments={depts}
          meId={user.id}
          canManageAdmins={can(user, "superAdmin.manage", { festId: user.festId })}
          canRaiseConcerns={can(user, "flag.raise", scope)}
          fixedDepartmentId={festWide ? undefined : user.departmentId}
        />
      </Card>
    </>
  );
}
