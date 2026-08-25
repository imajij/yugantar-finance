import { redirect } from "next/navigation";
import { and, asc, eq, isNull, ne, notInArray, or } from "drizzle-orm";
import { db } from "@/db";
import { departments, tickets } from "@/db/schema";
import { getSession } from "@/lib/session";
import { listCycles, listLabels, listProjects } from "@/lib/services/planning";
import { PageTitle } from "@/components/ui";
import { TicketForm } from "./form";

export default async function NewTicketPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  // A ticket asks *another* department for work (schema enforces it too).
  const [targets, labels, projects, cycles, parents] = await Promise.all([
    db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(
        eq(departments.festId, user.festId),
        eq(departments.isActive, true),
        ne(departments.id, user.departmentId),
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
  ]);

  return (
    <div className="max-w-xl">
      <PageTitle>Ask a department</PageTitle>
      <TicketForm
        departments={targets}
        labels={labels}
        projects={projects.map((p) => ({ id: String(p.id), name: String(p.name) }))}
        cycles={cycles.map((c) => ({ id: String(c.id), name: String(c.name) }))}
        parents={parents}
      />
    </div>
  );
}
