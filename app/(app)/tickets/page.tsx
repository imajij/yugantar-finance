import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listTickets, ticketCounts, type TicketScope } from "@/lib/services/tickets";
import { Amount, Card, Empty, PageTitle, StateChip } from "@/components/ui";

const SCOPES: { key: TicketScope; label: string; hint: string }[] = [
  { key: "inbox", label: "Inbox", hint: "Asked of your department" },
  { key: "outgoing", label: "Sent", hint: "Your department's asks of others" },
  { key: "mine", label: "Mine", hint: "Assigned to you" },
  { key: "raised", label: "Raised by me", hint: "Tickets you asked for" },
  { key: "all", label: "All", hint: "Everything you can see" },
];

const PRIORITY_TONE: Record<string, string> = {
  URGENT: "var(--state-bad-fg)", HIGH: "var(--yg-yellow)",
  MEDIUM: "var(--yg-text-soft)", LOW: "var(--yg-text-muted)",
};

/** PRD 9.5 / 20.9 — one board, four scopes, urgent-and-soonest first. */
export default async function TicketsPage({
  searchParams,
}: { searchParams: Promise<{ scope?: string; overdue?: string }> }) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const q = await searchParams;
  const scope = (SCOPES.find((s) => s.key === q.scope)?.key ?? "inbox") as TicketScope;
  const overdue = q.overdue === "1";

  const [rows, counts] = await Promise.all([
    listTickets(user, { view: scope, overdue }),
    ticketCounts(user),
  ]);

  const badge: Record<TicketScope, number> = {
    inbox: counts.inbox, outgoing: counts.outgoing, mine: counts.mine,
    raised: counts.awaitingMyConfirmation, all: 0,
  };

  return (
    <>
      <PageTitle
        action={
          <Link
            href="/tickets/new"
            className="rounded-full px-4 py-2 text-sm font-medium"
            style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
          >
            Ask a department
          </Link>
        }
      >
        Work tickets
      </PageTitle>

      {counts.untriaged > 0 && (
        <p className="mb-4 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-med-bg)", color: "var(--flag-med-fg)" }}>
          {counts.untriaged} ticket{counts.untriaged === 1 ? "" : "s"} waiting on your department to accept or reject.
        </p>
      )}
      {counts.awaitingMyConfirmation > 0 && (
        <p className="mb-4 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--state-decided-bg)", color: "var(--state-decided-fg)" }}>
          {counts.awaitingMyConfirmation} of your asks {counts.awaitingMyConfirmation === 1 ? "is" : "are"} marked done and waiting on you to confirm.
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {SCOPES.map((s) => (
          <Link
            key={s.key}
            href={`/tickets?scope=${s.key}${overdue ? "&overdue=1" : ""}`}
            title={s.hint}
            className="rounded-full px-3.5 py-1.5 text-sm"
            style={
              scope === s.key
                ? { background: "var(--yg-lime)", color: "var(--yg-on-accent)" }
                : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
            }
          >
            {s.label}
            {badge[s.key] > 0 && <span className="tnum ml-1.5 opacity-70">{badge[s.key]}</span>}
          </Link>
        ))}
        <Link
          href={`/tickets?scope=${scope}${overdue ? "" : "&overdue=1"}`}
          className="ml-auto rounded-full px-3.5 py-1.5 text-sm"
          style={
            overdue
              ? { background: "var(--state-bad-fg)", color: "var(--yg-on-accent)" }
              : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
          }
        >
          Overdue only{counts.overdue > 0 && <span className="tnum ml-1.5 opacity-70">{counts.overdue}</span>}
        </Link>
      </div>

      {rows.length === 0 ? (
        <Empty>
          {overdue ? "Nothing is overdue." : "No tickets in this view."}
        </Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((t) => (
            <Link key={t.id} href={`/tickets/${t.id}`} className="block">
              <Card className="hover:border-lime">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="tnum text-xs text-text-muted">{t.human_id}</span>
                      <StateChip state={t.status} />
                      <span className="text-xs font-medium" style={{ color: PRIORITY_TONE[t.priority] }}>
                        {t.priority.toLowerCase()}
                      </span>
                      {t.escalated && (
                        <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
                          escalated
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 text-sm text-text">{t.title}</p>
                    <p className="mt-1 text-xs text-text-muted">
                      {t.requesting_department} → {t.target_department}
                      {t.assignee ? ` · ${t.assignee}` : " · unassigned"}
                      {t.location ? ` · ${t.location}` : ""}
                      {t.comment_count > 0 ? ` · ${t.comment_count} comment${t.comment_count === 1 ? "" : "s"}` : ""}
                    </p>
                  </div>
                  <div className="text-right text-xs">
                    <p style={{ color: t.overdue ? "var(--state-bad-fg)" : "var(--yg-text-muted)" }}>
                      {t.overdue ? "overdue · " : "due "}
                      {new Date(t.due_at).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                    </p>
                    {t.estimated_cost_paise !== null && (
                      <p className="mt-1 text-text-muted"><Amount paise={t.estimated_cost_paise} /> est.</p>
                    )}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
