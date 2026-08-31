"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Required } from "@/components/ui";
import { ConfirmWithReason, Spinner } from "@/components/confirm";
import { ErrorNote } from "@/components/feedback";

export interface TransitionAction { action: string; requires: string[] }

interface Props {
  /** Where to POST: the entity's transitions endpoint. */
  endpoint: string;
  actions: TransitionAction[];
  /** Extra fields to demand beyond what the state machine requires. */
  extraFields?: Record<string, string[]>;
  /** Options for select-style fields, keyed by field name. */
  options?: Record<string, { value: string; label: string }[]>;
}

const LABEL: Record<string, string> = {
  SUBMIT: "Submit", RESUBMIT: "Resubmit", ENDORSE: "Endorse", SEND_BACK: "Send back",
  DECLINE: "Decline", APPROVE: "Approve", HOLD: "Hold", RESOLVE_HOLD: "Resolve hold",
  RECORD_PAYMENT: "Record payment", WITHDRAW: "Withdraw",
  ACCEPT: "Accept", BACKLOG: "Move to backlog", SCHEDULE: "Move to todo",
  ASK_INFO: "Ask for info", REPLY_INFO: "Reply", REJECT: "Reject",
  START: "Start", BLOCK: "Block", UNBLOCK: "Unblock", MARK_DONE: "Mark done",
  CONFIRM: "Confirm done", REOPEN: "Reopen", REASSIGN: "Reassign", CANCEL: "Cancel",
  ESCALATE: "Escalate",
  RECORD_ADVANCE: "Record advance", RECORD_BALANCE: "Record balance",
  CONFIRM_DELIVERY: "Confirm delivery", RELEASE_BALANCE: "Release balance",
  CLOSE: "Close", RECORD_REFUND: "Record refund", WRITE_OFF: "Write off", REINSTATE: "Reinstate",
};

/** Yellow is reserved for the one most important action on the screen (9.1 rule 2). */
const PRIMARY = new Set([
  "SUBMIT", "RESUBMIT", "ENDORSE", "APPROVE", "RECORD_PAYMENT",
  "ACCEPT", "START", "MARK_DONE", "CONFIRM", "RECORD_ADVANCE", "RELEASE_BALANCE", "CONFIRM_DELIVERY",
]);

/**
 * What an action will do, in the words of the thing about to happen.
 *
 * Anything here that needs exactly one written reason opens the confirm dialog
 * instead of an inline field, so the consequence is stated *before* the reason is
 * asked for. "Are you sure?" was never the question — "this releases the amount
 * back to the department and notifies the person who claimed it" is.
 */
const CONSEQUENCE: Record<string, string> = {
  DECLINE: "The amount is released back to the department's available balance and whoever claimed it is notified. They read your reason, so it is worth saying what was wrong.",
  SEND_BACK: "It goes back to the submitter to correct and resubmit. Nothing is lost and the amount stays counted as pending until they do.",
  REJECT: "The department that asked is told this will not be done. The ticket closes; raising it again means raising a new one.",
  WITHDRAW: "The claim is taken out of the queue and stops counting against your department's available balance. You cannot undo this.",
  HOLD: "Payment stops until Finance resolves it. The amount stays committed, so it is still counted against the department.",
  BLOCK: "The ticket stays assigned to you and stops counting as in progress. Whoever raised it is told why.",
  CANCEL: "The ticket closes and the department it was asked of stops seeing it. Anything already spent against it stays on the record.",
  REOPEN: "It goes back to whoever was working on it, and out of their done column.",
  ASK_INFO: "The ticket pauses and returns to whoever raised it. It comes back to this state once they answer.",
  CLOSE: "No new request can attach to it, and its unspent balance returns to the department's buffer.",
  ESCALATE: "Management and the target department's head are told. The ticket does not change state — this is a mark on it.",
};

/** Actions where the confirming button should read as consequential. */
const DESTRUCTIVE = new Set(["DECLINE", "REJECT", "WITHDRAW", "CANCEL", "HOLD", "BLOCK", "SEND_BACK"]);

/** The single free-text fields the dialog can collect on its own. */
const SINGLE_REASON = new Set(["reason", "note", "question", "answer"]);

const PROMPT: Record<string, string> = {
  reason: "Reason (the other party will see this)",
  note: "Note",
  question: "What do you need to know?",
  answer: "Your answer",
  approval_note: "Acknowledgement note — this request has an open High flag",
  payment_reference: "Payment reference (UTR)",
  paid_at: "Date paid",
  paid_paise: "Amount paid (₹)",
  milestone_id: "Milestone",
  assignee_id: "Assign to",
  delivered_at: "Date delivered",
  invoice_attachment_id: "Invoice",
  invoice_total_paise: "Invoice total (₹)",
  approved_value_paise: "Approved value (₹)",
  amount_paise: "Amount (₹)",
  received_at: "Date received",
};

const RUPEE_FIELDS = new Set([
  "paid_paise", "invoice_total_paise", "approved_value_paise", "amount_paise",
]);

export function TransitionActions({ endpoint, actions, extraFields = {}, options = {} }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldsFor = (action: string) => [
    ...(actions.find((a) => a.action === action)?.requires ?? []),
    ...(extraFields[action] ?? []),
  ];

  /**
   * One free-text field and nothing else → the dialog. Anything with a reference,
   * a date or an amount stays an inline form: those are data entry, not a decision
   * that needs its consequence spelled out.
   */
  const dialogField = (action: string): string | null => {
    const fields = fieldsFor(action);
    return fields.length === 1 && SINGLE_REASON.has(fields[0]) ? fields[0] : null;
  };

  async function run(action: string, raw: Record<string, string> = {}) {
    setBusy(true);
    setError(null);

    // Rupees in the form, paise on the wire (18.2 rule 4).
    const body: Record<string, unknown> = { action };
    for (const [k, v] of Object.entries(raw)) {
      body[k] = RUPEE_FIELDS.has(k) ? Math.round(Number(v) * 100) : v;
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "That did not work");
      return;
    }
    setOpen(null);
    router.refresh();
  }

  if (actions.length === 0) return null;

  const dialog = open && dialogField(open) ? open : null;
  const inlineOpen = open && !dialog ? open : null;

  return (
    <div className={`mt-4 ${busy ? "is-pending" : ""}`}>
      <div className="flex flex-wrap gap-2.5">
        {actions.map(({ action }) => (
          <Button
            key={action}
            tone={PRIMARY.has(action) ? "hero" : DESTRUCTIVE.has(action) ? "ghost" : "ghost"}
            disabled={busy}
            onClick={() => (fieldsFor(action).length > 0 ? setOpen(open === action ? null : action) : run(action))}
            style={
              DESTRUCTIVE.has(action) && !PRIMARY.has(action)
                ? { border: "1px solid var(--flag-high-bg)", color: "var(--flag-high-fg)" }
                : undefined
            }
          >
            {busy && open === action && <Spinner />}
            {LABEL[action] ?? action}
          </Button>
        ))}
      </div>

      {dialog && (
        <ConfirmWithReason
          open
          title={`${LABEL[dialog] ?? dialog}?`}
          consequence={CONSEQUENCE[dialog] ?? "This is recorded against your name and cannot be undone."}
          confirmLabel={LABEL[dialog] ?? dialog}
          cancelLabel="Leave it as it is"
          tone={DESTRUCTIVE.has(dialog) ? "destructive" : "default"}
          reason={{ label: PROMPT[dialogField(dialog)!] ?? "Reason" }}
          busy={busy}
          error={error}
          onConfirm={(text) => run(dialog, { [dialogField(dialog)!]: text })}
          onCancel={() => { setOpen(null); setError(null); }}
        />
      )}

      {inlineOpen && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(inlineOpen, Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)])));
          }}
        >
          {fieldsFor(inlineOpen).map((f) => (
            <div key={f}>
              {/* Every field the state machine asks for here is one it will not
                  proceed without, so the mark is unconditional. */}
              <label htmlFor={f} className="flex items-baseline gap-2 text-[13px] text-text-soft">
                {PROMPT[f] ?? f}
                <Required />
              </label>
              {options[f] ? (
                <select
                  id={f} name={f} required
                  className="mt-1.5 w-full rounded-[var(--r-control)] px-3.5 py-3 text-[14px]"
                  style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
                >
                  {options[f].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input
                  id={f} name={f} required
                  type={f.endsWith("_at") || f.endsWith("_on") ? "date" : RUPEE_FIELDS.has(f) ? "number" : "text"}
                  step={RUPEE_FIELDS.has(f) ? "0.01" : undefined}
                  min={RUPEE_FIELDS.has(f) ? "0" : undefined}
                  className="mt-1.5 w-full rounded-[var(--r-control)] px-3.5 py-3 text-[14px]"
                  style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
                />
              )}
            </div>
          ))}
          <Button type="submit" tone="primary" disabled={busy}>
            {busy && <Spinner />}
            {busy ? "Working…" : `Confirm ${LABEL[inlineOpen] ?? inlineOpen}`}
          </Button>
        </form>
      )}

      {error && !dialog && <ErrorNote className="mt-3">{error}</ErrorNote>}
    </div>
  );
}
