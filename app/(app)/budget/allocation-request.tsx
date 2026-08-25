"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPaise } from "@/lib/money";

/**
 * A department head asking for a different allocation, and Finance answering.
 *
 * The rule this works around is deliberate and stays: an allocation only ever moves
 * by transfer, decided by whoever holds the money (PRD 5.2, 7.1). A department that
 * could set its own budget could empty the reserve, and nothing downstream — the
 * five numbers, the close-out pack — would show it as anything other than normal.
 *
 * What was missing was the ask. Allocations were negotiated in a group chat and
 * only the outcome ever reached the system, so nobody could see what a department
 * had asked for, when, or why it was refused. Now the conversation is the record:
 * approving performs the transfer in the same transaction, and the note is what the
 * department reads.
 */

const FIELD =
  "w-full rounded-lg px-2.5 py-1.5 text-sm bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

function toPaise(rupees: string): number | null {
  const cleaned = rupees.trim().replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const message = (body: unknown) =>
  (body as { error?: { message?: string } })?.error?.message ?? "That did not work";

export interface PendingAsk {
  id: string;
  requestedPaise: number;
  reason: string;
  createdAt: string;
}

export function AskForBudget({
  departmentId, departmentName, allocatedPaise, pending,
}: {
  departmentId: string;
  departmentName: string;
  allocatedPaise: number;
  /** The one open ask, if there is one. Only one may be open at a time. */
  pending: PendingAsk | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState((allocatedPaise / 100).toString());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = toPaise(value);
  const delta = target === null ? 0 : target - allocatedPaise;

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/allocation-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        department_id: departmentId,
        requested_paise: target,
        reason: reason.trim(),
      }),
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return; }
    setOpen(false);
    setReason("");
    router.refresh();
  }

  async function withdraw() {
    setBusy(true);
    const res = await fetch(`/api/v1/allocation-requests/${pending!.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return; }
    router.refresh();
  }

  if (pending) {
    return (
      <div
        className="rounded-xl p-3 text-sm"
        style={{ background: "var(--state-waiting-bg)", color: "var(--state-waiting-fg)" }}
      >
        <p>
          Waiting on Finance: you asked for <strong>{formatPaise(pending.requestedPaise)}</strong>
          {" "}({formatPaise(pending.requestedPaise - allocatedPaise)} more than the{" "}
          {formatPaise(allocatedPaise)} allocated now).
        </p>
        <p className="mt-1 text-xs opacity-80">&ldquo;{pending.reason}&rdquo;</p>
        {error && <p className="mt-1 text-xs" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={withdraw}
          className="mt-2 rounded-full px-3 py-1 text-xs disabled:opacity-40"
          style={{ border: "1px solid currentColor" }}
        >
          {busy ? "Withdrawing…" : "Withdraw the request"}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setValue((allocatedPaise / 100).toString()); }}
        className="rounded-full px-3.5 py-1.5 text-sm"
        style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
      >
        Ask for a different budget
      </button>
    );
  }

  return (
    <div
      className="max-w-md space-y-2 rounded-xl p-3"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      <label className="block text-xs text-text-muted" htmlFor="ask-amount">
        What {departmentName} needs in total, in rupees
      </label>
      <input
        id="ask-amount"
        autoFocus
        value={value}
        inputMode="decimal"
        onChange={(e) => setValue(e.target.value)}
        className={`${FIELD} text-right tabular-nums`}
      />

      <textarea
        rows={3}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Why — what the extra covers, or what you no longer need"
        className={FIELD}
        aria-label="Reason for the request"
      />

      {target !== null && delta !== 0 && (
        <p className="text-[11px] text-text-muted">
          {delta > 0
            ? `Asking for ${formatPaise(delta)} more than you have now.`
            : `Returning ${formatPaise(-delta)} to Reserve.`}
        </p>
      )}
      {error && <p className="text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || target === null || delta === 0 || reason.trim().length < 10}
          onClick={submit}
          className="rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Sending…" : "Send to Finance"}
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

export function DecideAllocation({
  id, departmentName, requestedPaise, currentPaise, reason, requestedBy,
}: {
  id: string;
  departmentName: string;
  requestedPaise: number;
  currentPaise: number;
  reason: string;
  requestedBy: string;
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delta = requestedPaise - currentPaise;

  async function decide(decision: "APPROVE" | "DECLINE") {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/allocation-requests/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, note: note.trim() }),
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return; }
    router.refresh();
  }

  return (
    <div
      className="rounded-xl p-3"
      style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm">
          <strong>{departmentName}</strong> is asking for{" "}
          <span className="tnum">{formatPaise(requestedPaise)}</span>
          <span className="text-text-muted">
            {" · "}{delta > 0 ? `${formatPaise(delta)} more` : `${formatPaise(-delta)} back to Reserve`}
          </span>
        </p>
        <p className="text-xs text-text-muted">{requestedBy}</p>
      </div>
      <p className="mt-1 text-xs text-text-soft">&ldquo;{reason}&rdquo;</p>

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Your answer — the department reads this either way"
        className={`${FIELD} mt-2`}
        aria-label={`Note on the request from ${departmentName}`}
      />

      {error && <p className="mt-1 text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={busy || note.trim().length < 1}
          onClick={() => decide("APPROVE")}
          className="rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Working…" : "Approve and transfer"}
        </button>
        <button
          type="button"
          disabled={busy || note.trim().length < 1}
          onClick={() => decide("DECLINE")}
          className="rounded-full px-3 py-1 text-xs disabled:opacity-40"
          style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}
