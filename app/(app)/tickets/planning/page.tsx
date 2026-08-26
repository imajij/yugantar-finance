import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listCycles, listLabels, listProjects, listTemplates } from "@/lib/services/planning";
import { PageTitle } from "@/components/ui";
import { Cycles, Labels, Projects, Templates, type TemplateRow } from "./panels";

export const dynamic = "force-dynamic";

/** The board's vocabulary. Anyone who runs work shapes it; a Member uses it. */
export default async function PlanningPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "ticket.plan", { festId: user.festId, departmentId: user.departmentId })) nf();

  const [labels, projects, cycles, members, templates, depts] = await Promise.all([
    listLabels(user),
    listProjects(user),
    listCycles(user),
    db.select({ id: users.id, name: users.name }).from(users)
      .where(and(eq(users.festId, user.festId), eq(users.status, "ACTIVE")))
      .orderBy(asc(users.name)),
    // Retired ones included: this is the page that manages them, so it is the one
    // place they have to stay visible.
    listTemplates(user, { all: true }),
    db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
  ]);

  const simple = {
    projects: projects.map((p) => ({ id: String(p.id), name: String(p.name) })),
    cycles: cycles.map((c) => ({ id: String(c.id), name: String(c.name) })),
  };

  return (
    <div className="max-w-3xl">
      <PageTitle
        action={
          <Link
            href="/tickets"
            className="rounded-full px-4 py-2 text-sm"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            Back to the board
          </Link>
        }
      >
        Labels, templates &amp; projects
      </PageTitle>

      <p className="mb-6 text-sm text-text-muted">
        None of this decides anything. A label grants no permission and a project changes nobody&rsquo;s
        authority — they only change how the same tickets can be grouped and found.
      </p>

      <div className="space-y-10">
        <Labels labels={labels} />
        <Templates
          templates={templates as unknown as TemplateRow[]}
          departments={depts}
          labels={labels}
          projects={simple.projects}
          cycles={simple.cycles}
        />
        <Projects
          projects={projects.map((p) => ({
            id: String(p.id),
            name: String(p.name),
            status: String(p.status),
            lead_name: (p.lead_name as string) ?? null,
            starts_on: (p.starts_on as string) ?? null,
            ends_on: (p.ends_on as string) ?? null,
            ticket_count: Number(p.ticket_count),
            done_count: Number(p.done_count),
          }))}
          members={members}
        />
        <Cycles
          cycles={cycles.map((c) => ({
            id: String(c.id),
            name: String(c.name),
            starts_on: String(c.starts_on),
            ends_on: String(c.ends_on),
            is_current: Boolean(c.is_current),
            ticket_count: Number(c.ticket_count),
            done_count: Number(c.done_count),
          }))}
        />
      </div>
    </div>
  );
}
