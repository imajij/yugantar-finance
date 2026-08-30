import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listTickets, normalizeScope, ticketCounts } from "@/lib/services/tickets";
import { listCycles, listLabels, listProjects } from "@/lib/services/planning";
import { PageTitle } from "@/components/ui";
import { Board, type BoardTicket } from "./board";

export const dynamic = "force-dynamic";

/**
 * PRD 9.5 / 20.9 — one board, sliced however the reader needs it.
 *
 * Everything the board shows is decided here and passed down, because the filters
 * live in the URL: the page is re-rendered on every filter change rather than the
 * client holding a second copy of the list. That keeps one source of truth for what
 * a person may see — `listTickets` scopes by fest and by role — and makes any board
 * a link somebody can send.
 */
export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const q = await searchParams;
  const scope = normalizeScope(q.scope ?? "inbox");

  const [rows, counts, labels, projects, cycles, depts, members] = await Promise.all([
    listTickets(user, {
      view: scope,
      priority: q.priority,
      departmentId: q.department,
      labelIds: q.labels?.split(",").filter(Boolean),
      projectId: q.project,
      cycleId: q.cycle,
      overdue: q.overdue === "1",
      unassigned: q.unassigned === "1",
      q: q.q,
    }),
    ticketCounts(user),
    listLabels(user),
    listProjects(user),
    listCycles(user),
    db.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
    db.select({ id: users.id, name: users.name, departmentId: users.departmentId }).from(users)
      .where(and(eq(users.festId, user.festId), eq(users.status, "ACTIVE")))
      .orderBy(asc(users.name)),
  ]);

  // Serialised for the client boundary: dates cross it as strings either way, and
  // being explicit beats discovering it in the browser.
  const tickets: BoardTicket[] = rows.map((t) => ({ ...t, due_at: t.due_at.toISOString() }));

  return (
    <>
      <PageTitle
        action={
          <div className="flex items-center gap-2">
            {can(user, "ticket.plan", { festId: user.festId, departmentId: user.departmentId }) && (
              <Link
                href="/tickets/planning"
                className="rounded-full px-4 py-2 text-sm"
                style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
              >
                Labels &amp; projects
              </Link>
            )}
            <Link
              href="/tickets/new"
              className="rounded-full px-4 py-2 text-sm font-medium"
              style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
            >
              New ticket
            </Link>
          </div>
        }
      >
        Work tickets
      </PageTitle>

      {counts.untriaged > 0 && (
        <p
          className="mb-3 rounded-lg px-3 py-2 text-sm"
          style={{ background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }}
        >
          {counts.untriaged} ticket{counts.untriaged === 1 ? "" : "s"} waiting on your department to
          accept, backlog, or reject.
        </p>
      )}
      {counts.awaitingMyConfirmation > 0 && (
        <p
          className="mb-3 rounded-lg px-3 py-2 text-sm"
          style={{ background: "var(--state-decided-bg)", color: "var(--state-decided-fg)" }}
        >
          {counts.awaitingMyConfirmation} of your asks{" "}
          {counts.awaitingMyConfirmation === 1 ? "is" : "are"} marked done and waiting on you to confirm.
        </p>
      )}

      <Board
        tickets={tickets}
        labels={labels}
        projects={projects.map((p) => ({ id: String(p.id), name: String(p.name) }))}
        cycles={cycles.map((c) => ({ id: String(c.id), name: String(c.name) }))}
        departments={depts}
        members={members}
        counts={{
          inbox: counts.inbox,
          outgoing: counts.outgoing,
          assigned: counts.assigned,
          created: counts.created,
          subscribed: counts.subscribed,
          all: 0,
        }}
        me={{ id: user.id, departmentId: user.departmentId }}
      />
    </>
  );
}
