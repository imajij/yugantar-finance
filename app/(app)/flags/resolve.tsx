"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Every resolution demands a note (8.3): "acknowledged" with no reason is
 * indistinguishable from nobody having looked, which is the failure mode the whole
 * flag system exists to avoid.
 *
 * Withdrawing is the third answer and belongs only to whoever raised a concern by
 * hand. Clearing somebody else's flag stays Finance's call — but a person who
 * raised one in error, or got an answer five minutes later, should not have to ask
 * Finance to tidy up after them.
 */
export function ResolveFlag({
  id, canResolve, canWithdraw,
}: {
  id: string;
  canResolve: boolean;
  canWithdraw: boolean;
}) {
  const router = useRouter();
  const [action, setAction] = useState<"ACKNOWLEDGE" | "DISMISS" | "WITHDRAW" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/flags/${id}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, note }),
    });
    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "Could not resolve that flag");
      return;
    }
    setAction(null);
    setNote("");
    router.refresh();
  }

  if (!canResolve && !canWithdraw) return null;

  if (!action) {
    return (
      <div className="flex shrink-0 gap-1.5">
        {canResolve && (
          <>
            <button
              type="button"
              onClick={() => setAction("ACKNOWLEDGE")}
              className="rounded-full px-3 py-1.5 text-xs font-medium"
              style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
            >
              Acknowledge
            </button>
            <button
              type="button"
              onClick={() => setAction("DISMISS")}
              className="rounded-full px-3 py-1.5 text-xs"
              style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
            >
              Dismiss
            </button>
          </>
        )}
        {canWithdraw && (
          <button
            type="button"
            onClick={() => setAction("WITHDRAW")}
            className="rounded-full px-3 py-1.5 text-xs"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-muted)" }}
          >
            Withdraw
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm shrink-0 space-y-2">
      <label className="block text-xs text-text-muted">
        {action === "DISMISS"
          ? "Why does this rule not apply here?"
          : action === "WITHDRAW"
            ? "Why are you taking this back?"
            : "What did you check, and why is it fine?"}
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          autoFocus
          className="mt-1 w-full rounded-lg p-2 text-sm"
          style={{ background: "var(--yg-bg)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
        />
      </label>
      {error && <p className="text-xs" style={{ color: "var(--state-bad-fg)" }}>{error}</p>}
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy || note.trim().length < 3}
          onClick={submit}
          className="rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Saving…" : action === "DISMISS" ? "Dismiss" : action === "WITHDRAW" ? "Withdraw" : "Acknowledge"}
        </button>
        <button
          type="button"
          onClick={() => { setAction(null); setError(null); }}
          className="rounded-full px-3 py-1.5 text-xs"
          style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
