import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { getTicketDetail } from "@/lib/services/tickets";
import { can, satisfiesActorConstraints } from "@/lib/authz";
import { TICKET_TRANSITIONS } from "@/lib/state-machines/ticket";
import { chipStyle, stateLabel } from "@/lib/state-chip";
import { Amount, Card, PageTitle, StateChip } from "@/components/ui";
import { TransitionActions } from "@/components/transitions";
import { Timeline } from "@/components/timeline";
import { CommentThread } from "@/components/comments";

export default async function TicketDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const t = await getTicketDetail(user, id).catch(() => null);
  if (!t) nf();

  const resource = {
    festId: user.festId,
    departmentId: t.requestingDepartmentId,
    requestingDepartmentId: t.requestingDepartmentId,
    targetDepartmentId: t.targetDepartmentId,
    submitterId: t.requesterId,
    requesterId: t.requesterId,
    assigneeId: t.assigneeId ?? undefined,
    status: t.status,
  };

  /** Same table the API validates against (18.2 rule 2) — the UI only hides. */
  const actions = TICKET_TRANSITIONS
    .filter((tr) => tr.from === t.status)
    .filter((tr) => tr.roles.includes(user.role))
    .filter((tr) => satisfiesActorConstraints(tr.actor, user, resource))
    .filter((tr) => {
      if (["ACCEPT", "REJECT", "REASSIGN"].includes(tr.action)) return can(user, "ticket.triage", resource);
      if (["START", "BLOCK", "UNBLOCK", "MARK_DONE"].includes(tr.action)) return can(user, "ticket.work", resource);
      if (["CONFIRM", "REOPEN", "CANCEL"].includes(tr.action)) return can(user, "ticket.close", resource);
      return true;
    })
    .map((tr) => ({ action: tr.action, requires: [...(tr.requires ?? [])] }));

  // Reassignment can only land on someone in the department the ticket was sent to.
  const assignees = actions.some((a) => a.action === "REASSIGN")
    ? await db.select({ id: users.id, name: users.name }).from(users)
        .where(and(
          eq(users.festId, user.festId),
          eq(users.departmentId, t.targetDepartmentId),
          eq(users.status, "ACTIVE"),
        ))
    : [];

  const overdue = new Date(t.dueAt) < new Date()
    && !["CLOSED", "REJECTED", "CANCELLED"].includes(t.status);

  return (
    <div className="max-w-3xl">
      <PageTitle action={<StateChip state={t.status} />}>
        <span className="tnum">{t.humanId}</span>
      </PageTitle>

      <Card>
        <p className="text-lg">{t.title}</p>
        <p className="mt-2 whitespace-pre-wrap text-sm text-text-soft">{t.description}</p>

        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Row label="Asked by">{t.requester} · {t.requesting_department}</Row>
          <Row label="Asked of">{t.target_department}</Row>
          <Row label="Owner">{t.assignee ?? <span className="text-text-muted">unassigned</span>}</Row>
          <Row label="Priority">{t.priority.toLowerCase()}</Row>
          <Row label="Due">
            <span className="tnum" style={{ color: overdue ? "var(--state-bad-fg)" : undefined }}>
              {new Date(t.dueAt).toLocaleString("en-IN")}{overdue ? " · overdue" : ""}
            </span>
          </Row>
          {t.location && <Row label="Where">{t.location}</Row>}
          {t.estimatedCostPaise !== null && (
            <Row label="Estimated cost"><Amount paise={t.estimatedCostPaise} /></Row>
          )}
          {t.line_item && <Row label="Line item">{t.line_item}</Row>}
          {t.project && <Row label="Project">{t.project}</Row>}
          {t.cycle && <Row label="Cycle">{t.cycle}</Row>}
          {t.parent_human_id && (
            <Row label="Sub-ticket of">
              <Link href={`/tickets/${t.parentId}`} className="hover:text-lime">
                <span className="tnum">{t.parent_human_id}</span> {t.parent_title}
              </Link>
            </Row>
          )}
        </dl>

        {t.labels.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {t.labels.map((l) => (
              <span
                key={l.id}
                className="rounded-full px-2 py-0.5 text-xs"
                style={{ background: `${l.color}22`, color: l.color, border: `1px solid ${l.color}55` }}
              >
                {l.name}
              </span>
            ))}
          </div>
        )}

        {t.infoRequest && (
          <p className="mt-4 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-med-bg)", color: "var(--flag-med-fg)" }}>
            Waiting on an answer: {t.infoRequest}
          </p>
        )}
        {t.blockedReason && (
          <p className="mt-3 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
            Blocked: {t.blockedReason}
          </p>
        )}
        {t.rejectReason && (
          <p className="mt-3 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
            Rejected: {t.rejectReason}
          </p>
        )}
        {t.escalatedAt && (
          <p className="mt-3 text-xs text-text-muted">
            Escalated {new Date(t.escalatedAt).toLocaleString("en-IN")}.
          </p>
        )}
      </Card>

      {actions.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Actions</h2>
          <TransitionActions
            endpoint={`/api/v1/tickets/${t.id}/transitions`}
            actions={actions}
            options={{ assignee_id: assignees.map((a) => ({ value: a.id, label: a.name })) }}
          />
        </Card>
      )}

      {t.children.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">
            Sub-tickets
            <span className="tnum ml-2 text-text-muted">
              {t.children.filter((c) => c.status === "DONE" || c.status === "CLOSED").length}/{t.children.length}
            </span>
          </h2>
          <ul className="mt-3 space-y-1.5">
            {t.children.map((c) => (
              <li key={c.id} className="flex items-center gap-2 text-sm">
                <span
                  className="rounded-full px-2 py-0.5 text-xs font-medium"
                  style={chipStyle(c.status)}
                >
                  {stateLabel(c.status)}
                </span>
                <Link href={`/tickets/${c.id}`} className="min-w-0 truncate hover:text-lime">
                  <span className="tnum mr-1.5 text-xs text-text-muted">{c.humanId}</span>
                  {c.title}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Timeline events={t.timeline} />

      <CommentThread entityType="TICKET" entityId={t.id} comments={t.comments} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
