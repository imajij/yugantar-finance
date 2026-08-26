import { notFound as nf, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listUsers } from "@/lib/services/admin";
import { Card, PageTitle } from "@/components/ui";
import { People } from "../admin/panels";

export const dynamic = "force-dynamic";

/**
 * A department head's own team (PRD 5.1).
 *
 * The same panel as Admin's People, at one department's scale. What a head may do
 * here — add a member, deactivate one, resend an invitation — is the whole list;
 * roles, departments and the administrator flag are Finance's and do not appear.
 * That is enforced in `assertMayManage`, not here: this page only stops showing
 * controls that would be refused.
 *
 * Finance never lands here. They have Admin, which is this page plus the fest, and
 * a bookmark to this URL sends them there rather than opening a second door onto
 * the same roster.
 */
export default async function TeamPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  const scope = { festId: user.festId, departmentId: user.departmentId };
  if (!can(user, "user.manageOwnTeam", scope)) nf();
  if (can(user, "user.manage", { festId: user.festId })) redirect("/admin");

  // Scoped by the service, not by a parameter this page passes — there is nothing
  // here a head could edit to widen it.
  const people = await listUsers(user);

  return (
    <>
      <PageTitle subtitle={`${people.length} ${people.length === 1 ? "person" : "people"}`}>
        {user.departmentName}
      </PageTitle>

      <Card>
        <h2 className="font-display text-sm">Your team</h2>
        <p className="mt-1 text-xs text-text-muted">
          Adding someone emails them a sign-in link and puts them in your department&rsquo;s
          channel. Deactivating keeps everything they filed, ends their sessions, and takes them
          out of the channel — it is how somebody leaves, not how their history does. Roles and
          departments are Finance&rsquo;s to set; ask them if somebody needs to move or step up.
        </p>
        <People
          users={people}
          departments={[]}
          meId={user.id}
          canManageAdmins={false}
          canRaiseConcerns={can(user, "flag.raise", scope)}
          fixedDepartmentId={user.departmentId}
        />
      </Card>
    </>
  );
}
