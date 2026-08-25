"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {actions.map(({ action }) => (
          <button
            key={action}
            disabled={busy}
            onClick={() => (fieldsFor(action).length > 0 ? setOpen(open === action ? null : action) : run(action))}
            className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={
              PRIMARY.has(action)
                ? { background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }
                : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
            }
          >
            {LABEL[action] ?? action}
          </button>
        ))}
      </div>

      {open && (
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            run(open, Object.fromEntries([...data.entries()].map(([k, v]) => [k, String(v)])));
          }}
        >
          {fieldsFor(open).map((f) => (
            <div key={f}>
              <label htmlFor={f} className="text-sm text-text-soft">{PROMPT[f] ?? f}</label>
              {options[f] ? (
                <select
                  id={f} name={f} required
                  className="mt-1 w-full rounded-lg px-3 py-2.5 text-sm"
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
                  className="mt-1 w-full rounded-lg px-3 py-2.5 text-sm"
                  style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
                />
              )}
            </div>
          ))}
          <button
            type="submit" disabled={busy}
            className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
          >
            {busy ? "Working…" : `Confirm ${LABEL[open] ?? open}`}
          </button>
        </form>
      )}

      {error && (
        <p className="mt-3 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
