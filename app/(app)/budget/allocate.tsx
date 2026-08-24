"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPaise } from "@/lib/money";

const INPUT =
  "rounded-lg px-2.5 py-1.5 text-sm text-right tabular-nums bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)] w-32";

/** Rupees typed by a person → integer paise. Rejects anything that is not money. */
function toPaise(rupees: string): number | null {
  const cleaned = rupees.trim().replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/**
 * Sets one department's allocation, from the budget table.
 *
 * The control asks for a *total* — "this department gets ₹6,00,000" — because that is
 * how anyone thinks about a budget. What it sends is the difference, as a transfer to
 * or from Reserve, because that is the only way an allocation is allowed to move
 * (7.1): every rupee that changes hands carries a reason and leaves an audit row.
 * Presenting the transfer ledger directly would be truer to the model and much worse
 * to use, so the translation happens here and the reason is still required.
 *
 * Nothing is validated here beyond the shape of the number. Whether the reserve
 * covers it, and whether the department would drop below what it has already
 * committed, are decided in `transferBudget` under a row lock — a check in the
 * browser would be advice, not a rule.
 */
export function Allocate({
  departmentId,
  departmentName,
  allocatedPaise,
  reservePaise,
}: {
  departmentId: string;
  departmentName: string;
  allocatedPaise: number;
  reservePaise: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState((allocatedPaise / 100).toString());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const target = toPaise(value);
  const delta = target === null ? 0 : target - allocatedPaise;
  const overReserve = delta > reservePaise;

  async function save() {
    if (target === null) {
      setError("Enter an amount in rupees, like 600000 or 600000.50");
      return;
    }
    if (delta === 0) {
      setOpen(false);
      return;
    }

    setBusy(true);
    setError(null);

    // Positive: out of Reserve into the department. Negative: back again.
    const res = await fetch("/api/v1/budget-transfers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(delta > 0 ? { to_department_id: departmentId } : { from_department_id: departmentId }),
        amount_paise: Math.abs(delta),
        reason: reason.trim(),
      }),
    });

    setBusy(false);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setError(body?.error?.message ?? "That allocation could not be made");
      return;
    }

    setOpen(false);
    setReason("");
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); setValue((allocatedPaise / 100).toString()); }}
        className="rounded-full px-3 py-1 text-xs"
        style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
      >
        {allocatedPaise === 0 ? "Allocate" : "Change"}
      </button>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-text-muted">₹</span>
        <input
          autoFocus
          value={value}
          inputMode="decimal"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}
          className={INPUT}
          aria-label={`New allocation for ${departmentName} in rupees`}
        />
      </div>

      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (recorded)"
        className="w-56 rounded-lg border border-[var(--yg-surface-2)] bg-[var(--yg-bg-app)] px-2.5 py-1.5 text-xs text-[var(--yg-text)]"
      />

      {/* What this will actually do, in the model the system records. */}
      {target !== null && delta !== 0 && (
        <p className="text-[11px] text-text-muted">
          {delta > 0
            ? `Moves ${formatPaise(delta)} from Reserve`
            : `Returns ${formatPaise(-delta)} to Reserve`}
          {overReserve && (
            <span style={{ color: "var(--flag-high-fg)" }}>
              {" "}· Reserve holds {formatPaise(reservePaise)}
            </span>
          )}
        </p>
      )}

      {error && (
        <p className="max-w-56 text-right text-[11px]" style={{ color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}

      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy || target === null || delta === 0 || reason.trim().length < 3}
          onClick={save}
          className="rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Saving…" : "Save"}
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
