"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Flag } from "lucide-react";

/**
 * Raising a concern by hand (PRD 8.3).
 *
 * Until now every flag came from a rule, which means the system could only notice
 * what somebody had thought to encode. Most of what actually goes wrong at a fest
 * is noticed by a person first — a receipt that looks reused, a department sitting
 * on work, an HOD approving things they shouldn't — and there was nowhere to put
 * that except a message nobody could resolve or count.
 *
 * It lands in the same queue as F1–F14 and resolves the same way, so a concern
 * cannot quietly evaporate: acknowledging or dismissing it takes a note either way.
 */

export type ConcernTarget =
  | "REIMBURSEMENT" | "VENDOR_REQUEST" | "LINE_ITEM" | "DEPARTMENT" | "USER";

const SEVERITIES = [
  { key: "HIGH", label: "High", hint: "Money should not move until somebody looks" },
  { key: "MEDIUM", label: "Medium", hint: "Worth a look before this is approved" },
  { key: "LOW", label: "Low", hint: "Noting it, no urgency" },
] as const;

export function RaiseConcern({
  entityType, entityId, label = "Raise a concern", allowed = true,
}: {
  entityType: ConcernTarget;
  entityId: string;
  label?: string;
  /** The server's `can(user, "flag.raise")`. Hiding is never the enforcement. */
  allowed?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [severity, setSeverity] = useState<"HIGH" | "MEDIUM" | "LOW">("MEDIUM");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (!allowed) return null;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        entity_type: entityType, entity_id: entityId,
        severity, explanation: text.trim(),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError((body as { error?: { message?: string } })?.error?.message ?? "That could not be raised");
      return;
    }
    setDone(true);
    setOpen(false);
    setText("");
    router.refresh();
  }

  if (done && !open) {
    return (
      <span className="text-xs" style={{ color: "var(--flag-medium-fg)" }}>
        Raised — it is in the flag queue now.
      </span>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs"
        style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
      >
        <Flag size={13} aria-hidden /> {label}
      </button>
    );
  }

  return (
    <div
      className="w-full max-w-md space-y-2 rounded-xl p-3"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      <div className="flex flex-wrap gap-1.5">
        {SEVERITIES.map((s) => (
          <button
            key={s.key}
            type="button"
            title={s.hint}
            onClick={() => setSeverity(s.key)}
            className="rounded-full px-2.5 py-1 text-xs"
            style={
              severity === s.key
                ? { color: `var(--flag-${s.key.toLowerCase()}-fg)`, background: `var(--flag-${s.key.toLowerCase()}-bg)` }
                : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-muted)" }
            }
          >
            {s.label}
          </button>
        ))}
      </div>

      <textarea
        autoFocus
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="What is wrong, and what should whoever picks this up check?"
        className="w-full rounded-lg px-2.5 py-2 text-sm"
        style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
        aria-label="What the concern is"
      />

      <p className="text-[11px] text-text-muted">
        {severity === "HIGH"
          ? "High tells Finance straight away, by email."
          : "It joins the flag queue, worst and oldest first."}
      </p>
      {error && <p className="text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || text.trim().length < 10}
          onClick={submit}
          className="rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Raising…" : "Raise it"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="rounded-full px-3 py-1 text-xs"
          style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
