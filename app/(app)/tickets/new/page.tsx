import { redirect } from "next/navigation";
import { and, asc, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import { db } from "@/db";
import { departments, tickets } from "@/db/schema";
import { getSession } from "@/lib/session";
import { listCycles, listLabels, listProjects, listTemplates } from "@/lib/services/planning";
import { PageTitle } from "@/components/ui";
import { TicketForm } from "./form";

export default async function NewTicketPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  /*
   * A member raises work with their own department's head and nobody else; anybody
   * who acts across departments is asking a different one. So the list of who this
   * can be addressed to is the inverse of itself depending on who is looking, and
   * for a member it has exactly one entry — which the form shows as a fact rather
   * than a choice.
   */
  const raisesToOwn = user.role === "MEMBER";

  const [targets, labels, projects, cycles, parents, templates] = await Promise.all([
    db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(
        eq(departments.festId, user.festId),
        eq(departments.isActive, true),
        raisesToOwn ? eq(departments.id, user.departmentId) : ne(departments.id, user.departmentId),
      ))
      .orderBy(departments.name),
    listLabels(user),
    listProjects(user),
    listCycles(user),
    // Only live, top-level tickets you are party to: sub-tickets go one level deep,
    // and hanging work off something already closed helps nobody.
    db.select({ id: tickets.id, humanId: tickets.humanId, title: tickets.title }).from(tickets)
      .where(and(
        eq(tickets.festId, user.festId),
        isNull(tickets.deletedAt),
        isNull(tickets.parentId),
        notInArray(tickets.status, ["CLOSED", "REJECTED", "CANCELLED"]),
        or(
          eq(tickets.requestingDepartmentId, user.departmentId),
          eq(tickets.targetDepartmentId, user.departmentId),
        ),
      ))
      .orderBy(asc(tickets.humanId))
      .limit(100),
    // Filtered by the service to what this caller could actually raise — a member
    // is not shown a template addressed to a department they may not ask.
    listTemplates(user),
  ]);

  return (
    <div className="max-w-xl">
      <PageTitle
        subtitle={
          raisesToOwn
            ? `This goes to ${user.departmentName}'s head, who takes it from there.`
            : undefined
        }
      >
        {raisesToOwn ? `Ask ${user.departmentName}` : "Ask a department"}
      </PageTitle>
      <TicketForm
        departments={targets}
        fixedTarget={raisesToOwn}
        labels={labels}
        projects={projects.map((p) => ({ id: String(p.id), name: String(p.name) }))}
        cycles={cycles.map((c) => ({ id: String(c.id), name: String(c.name) }))}
        parents={parents}
        templates={templates.map((t) => ({
          id: String(t.id),
          name: String(t.name),
          summary: (t.summary as string) ?? null,
          target_department_id: (t.target_department_id as string) ?? null,
          title: (t.title as string) ?? null,
          body: (t.body as string) ?? null,
          priority: String(t.priority),
          location: (t.location as string) ?? null,
          due_in_hours: t.due_in_hours === null ? null : Number(t.due_in_hours),
          project_id: (t.project_id as string) ?? null,
          cycle_id: (t.cycle_id as string) ?? null,
          label_ids: ((t.labels ?? []) as { id: string }[]).map((l) => l.id),
        }))}
      />
    </div>
  );
}
