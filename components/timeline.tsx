import { Card } from "./ui";

export interface TimelineEvent {
  action: string;
  reason: string | null;
  actor: string | null;
  createdAt: Date;
}

/** Verbs the audit log stores, in the words a committee member would use. */
const LABELS: Record<string, string> = {
  SUBMIT: "Submitted", RESUBMIT: "Resubmitted", ENDORSE: "Endorsed by the department HOD",
  SEND_BACK: "Sent back for changes", DECLINE: "Declined", APPROVE: "Approved by Finance",
  HOLD: "Payment put on hold", RESOLVE_HOLD: "Hold resolved", RECORD_PAYMENT: "Payment recorded",
  WITHDRAW: "Withdrawn by the submitter",
  ACCEPT: "Accepted", ASK_INFO: "Asked for more information", REPLY_INFO: "Replied",
  REJECT: "Rejected", START: "Work started", BLOCK: "Blocked", UNBLOCK: "Unblocked",
  MARK_DONE: "Marked done", CONFIRM: "Confirmed done", REOPEN: "Reopened",
  REASSIGN: "Reassigned", CANCEL: "Cancelled", ESCALATE: "Escalated",
  RECORD_ADVANCE: "Advance payment", RECORD_BALANCE: "Balance payment",
  RECORD_REMAINING: "Remaining payment",
  CONFIRM_DELIVERY: "Delivery confirmed", RELEASE_BALANCE: "Balance released",
  CLOSE: "Closed", RECORD_REFUND: "Refund recorded",
  WRITE_OFF: "Written off", REINSTATE: "Reinstated",
};

function humanAction(action: string): string {
  const [, verb] = action.split(".transition.");
  if (verb) return LABELS[verb] ?? verb;
  if (action.endsWith(".create")) return "Created";
  if (action.endsWith(".update")) return "Edited";
  if (action.endsWith(".submit")) return "Submitted";
  if (action.endsWith(".tranche.record")) return "Money received";
  return action;
}

export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <Card className="mt-4">
      <h2 className="font-display text-sm">Timeline</h2>
      <ol className="mt-3 space-y-3">
        {events.map((e, i) => (
          <li key={i} className="text-sm">
            <span className="text-text">{humanAction(e.action)}</span>
            <span className="text-text-muted"> · {e.actor ?? "System"} · </span>
            <span className="tnum text-xs text-text-muted">{new Date(e.createdAt).toLocaleString("en-IN")}</span>
            {e.reason && <p className="mt-0.5 text-xs text-text-soft">&ldquo;{e.reason}&rdquo;</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
