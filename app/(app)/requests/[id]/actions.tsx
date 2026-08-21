"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Props {
  requestId: string;
  actions: { action: string; requires: string[] }[];
  hasOpenHighFlag: boolean;
}

const LABEL: Record<string, string> = {
  SUBMIT: "Submit", RESUBMIT: "Resubmit", ENDORSE: "Endorse", SEND_BACK: "Send back",
  DECLINE: "Decline", APPROVE: "Approve", HOLD: "Hold", RESOLVE_HOLD: "Resolve hold",
  RECORD_PAYMENT: "Record payment", WITHDRAW: "Withdraw",
};

/** Yellow is reserved for the one most important action on the screen (9.1 rule 2). */
const PRIMARY = new Set(["SUBMIT", "RESUBMIT", "ENDORSE", "APPROVE", "RECORD_PAYMENT"]);

const PROMPT: Record<string, string> = {
  reason: "Reason (the submitter will see this)",
  note: "Note",
  approval_note: "Acknowledgement note — this request has an open High flag",
  payment_reference: "Payment reference (UTR)",
  paid_at: "Date paid",
};

export function TransitionActions({ requestId, actions, hasOpenHighFlag }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function fieldsFor(action: string): string[] {
    const base = actions.find((a) => a.action === action)?.requires ?? [];
    // 8.3 — approving over an open High flag needs an acknowledgement note.
    return action === "APPROVE" && hasOpenHighFlag ? [...base, "approval_note"] : base;
  }

  async function run(action: string, body: Record<string, string> = {}) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/reimbursements/${requestId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, ...body }),
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

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        {actions.map(({ action }) => {
          const needs = fieldsFor(action);
          const primary = PRIMARY.has(action);
          return (
            <button
              key={action}
              disabled={busy}
              onClick={() => (needs.length > 0 ? setOpen(open === action ? null : action) : run(action))}
              className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={
                primary
                  ? { background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }
                  : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
              }
            >
              {LABEL[action] ?? action}
            </button>
          );
        })}
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
              <input
                id={f} name={f} required
                type={f === "paid_at" ? "date" : "text"}
                className="mt-1 w-full rounded-lg px-3 py-2.5 text-sm"
                style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
              />
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
