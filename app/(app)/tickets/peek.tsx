"use client";

import Link from "next/link";
import { ArrowUpRight, X } from "lucide-react";
import { chipStyle, stateLabel } from "@/lib/state-chip";
import { formatPaise } from "@/lib/money";
import { IconButton } from "@/components/ui";
import type { BoardTicket } from "./board";

/**
 * Reading a ticket without leaving the board.
 *
 * Half of what a board is for is deciding whether a card matters, and that usually
 * needs one more sentence than a card can hold. Navigating away to find it loses
 * the column, the filters and the scroll position, so people stop looking and start
 * guessing from the title.
 *
 * `Space` opens this on the focused row and closes it again. Everything in it comes
 * from the row the board already has, so it costs no request — which is the whole
 * reason it can be this cheap to open.
 */
export function Peek({
  ticket, onClose,
}: {
  ticket: BoardTicket | null;
  onClose: () => void;
}) {
  if (!ticket) return null;

  const due = new Date(ticket.due_at).toLocaleString("en-IN", {
    weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  });

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col"
      style={{ background: "var(--yg-bg-app)", borderLeft: "1px solid var(--yg-surface-2)" }}
      role="dialog"
      aria-label={`${ticket.human_id} — ${ticket.title}`}
    >
      <header
        className="flex shrink-0 items-center justify-between gap-3 px-5 py-4"
        style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
      >
        <span className="flex items-center gap-2.5">
          <span className="tnum text-[12px] text-text-muted">{ticket.human_id}</span>
          <span
            className="inline-flex items-center gap-[6px] rounded-full py-[4px] pr-2.5 pl-2 text-[11.5px] font-medium"
            style={chipStyle(ticket.status)}
          >
            <span className="size-[6px] rounded-full" style={{ background: chipStyle(ticket.status).color }} aria-hidden />
            {stateLabel(ticket.status)}
          </span>
        </span>
        <span className="flex items-center gap-1.5">
          <Link
            href={`/tickets/${ticket.id}`}
            className="tap text-text-muted hover:text-text"
            aria-label="Open the full ticket"
            title="Open the full ticket"
          >
            <ArrowUpRight size={17} aria-hidden />
          </Link>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} aria-hidden />
          </IconButton>
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-5">
        <h2 className="text-[19px] leading-snug">{ticket.title}</h2>

        {ticket.labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {ticket.labels.map((l) => (
              <span
                key={l.id}
                className="rounded-full px-2.5 py-0.5 text-[11.5px]"
                style={{ background: `${l.color}22`, color: l.color, border: `1px solid ${l.color}55` }}
              >
                {l.name}
              </span>
            ))}
          </div>
        )}

        <dl className="flex flex-col gap-0">
          <Row label="Asked by">{ticket.requester} · {ticket.requesting_department}</Row>
          <Row label="Asked of">{ticket.target_department}</Row>
          <Row label="Owner">{ticket.assignee ?? <span className="text-text-muted">unassigned</span>}</Row>
          <Row label="Priority">{ticket.priority[0] + ticket.priority.slice(1).toLowerCase()}</Row>
          <Row label="Due">
            <span className="tnum" style={{ color: ticket.overdue ? "var(--flag-high-fg)" : undefined }}>
              {due}{ticket.overdue ? " · overdue" : ""}
            </span>
          </Row>
          {ticket.location && <Row label="Where">{ticket.location}</Row>}
          {ticket.estimated_cost_paise !== null && (
            <Row label="Estimated"><span className="tnum">{formatPaise(ticket.estimated_cost_paise)}</span></Row>
          )}
          {ticket.project && <Row label="Project">{ticket.project}</Row>}
          {ticket.cycle && <Row label="Cycle">{ticket.cycle}</Row>}
          {ticket.parent_human_id && (
            <Row label="Sub-ticket of"><span className="tnum">{ticket.parent_human_id}</span></Row>
          )}
          {ticket.child_count > 0 && (
            <Row label="Sub-tickets">
              <span className="tnum">{ticket.child_done_count}/{ticket.child_count} done</span>
            </Row>
          )}
          {ticket.blocked_by > 0 && (
            <Row label="Blocked by">
              <span style={{ color: "var(--flag-med-fg)" }}>
                <span className="tnum">{ticket.blocked_by}</span> open ticket
                {ticket.blocked_by === 1 ? "" : "s"}
              </span>
            </Row>
          )}
        </dl>

        <p className="text-[12.5px] leading-relaxed text-text-muted">
          The description, the timeline and the comments are on the ticket itself &mdash; this is
          the card, opened far enough to decide whether it is the one you want.
        </p>

        <Link
          href={`/tickets/${ticket.id}`}
          className="flex h-[var(--row-h)] items-center justify-center gap-2 rounded-full text-[13.5px] font-bold"
          style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
        >
          Open {ticket.human_id}
        </Link>
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      className="flex items-baseline justify-between gap-4 py-2.5"
      style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
    >
      <dt className="shrink-0 text-[12px] text-text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[13px]">{children}</dd>
    </div>
  );
}
