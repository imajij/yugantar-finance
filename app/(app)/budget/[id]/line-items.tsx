"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, RotateCcw, X } from "lucide-react";
import { formatPaise } from "@/lib/money";

/**
 * Creating, editing and closing line items, from the department budget table.
 *
 * The API has always allowed this; there was simply no control for it, which meant
 * a department's allocation could only be broken down by somebody with a REST
 * client. Everything below is a thin form over `/api/v1` — no rule is decided here.
 * The two that matter (Σ line items ≤ allocation, and a line item never shrinking
 * below its own committed + spent) are enforced in `lib/services/line-items.ts`
 * under a row lock, because a check in the browser is advice, not a rule.
 */

const FIELD =
  "w-full rounded-lg px-2.5 py-1.5 text-sm bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

export interface ExpenseTypeOption { id: string; name: string }

/** Rupees typed by a person → integer paise. Rejects anything that is not money. */
function toPaise(rupees: string): number | null {
  const cleaned = rupees.trim().replace(/[₹,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

function errorFrom(body: unknown): string {
  const e = (body as { error?: { message?: string; details?: Record<string, number> } })?.error;
  if (!e) return "That did not work";
  // The over-allocation error carries the arithmetic; showing it beats "invalid".
  if (typeof e.details?.over_by_paise === "number") {
    return `${e.message} — over by ${formatPaise(e.details.over_by_paise)}`;
  }
  return e.message ?? "That did not work";
}

interface Fields {
  name: string;
  description: string;
  planned: string;
  expenseTypeId: string;
}

function Form({
  initial, expenseTypes, submitLabel, busy, error, onSubmit, onCancel,
}: {
  initial: Fields;
  expenseTypes: ExpenseTypeOption[];
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (f: Fields) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState(initial);
  const paise = toPaise(f.planned);

  return (
    <div className="space-y-2 rounded-xl p-3" style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}>
      <div className="grid gap-2 sm:grid-cols-[1fr_10rem]">
        <input
          autoFocus
          value={f.name}
          onChange={(e) => setF({ ...f, name: e.target.value })}
          placeholder="What it is — “Sound system”"
          className={FIELD}
          aria-label="Line item name"
        />
        <input
          value={f.planned}
          inputMode="decimal"
          onChange={(e) => setF({ ...f, planned: e.target.value })}
          placeholder="Planned ₹"
          className={`${FIELD} text-right tabular-nums`}
          aria-label="Planned amount in rupees"
        />
      </div>

      <input
        value={f.description}
        onChange={(e) => setF({ ...f, description: e.target.value })}
        placeholder="A note, if the name is not enough (optional)"
        className={FIELD}
        aria-label="Description"
      />

      <select
        value={f.expenseTypeId}
        onChange={(e) => setF({ ...f, expenseTypeId: e.target.value })}
        className={FIELD}
        aria-label="Default expense type"
      >
        <option value="">No default expense type</option>
        {expenseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>

      {paise !== null && paise > 0 && (
        <p className="text-[11px] text-text-muted">{formatPaise(paise)} planned</p>
      )}
      {error && <p className="text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || f.name.trim().length < 2 || paise === null}
          onClick={() => onSubmit(f)}
          className="rounded-full px-3 py-1 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Saving…" : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-xs"
          style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const EMPTY: Fields = { name: "", description: "", planned: "", expenseTypeId: "" };

export function NewLineItem({
  departmentId, expenseTypes, availableToPlanPaise,
}: {
  departmentId: string;
  expenseTypes: ExpenseTypeOption[];
  /** Allocation minus what is already planned — what is left to break down. */
  availableToPlanPaise: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(f: Fields) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/departments/${departmentId}/line-items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: f.name.trim(),
        description: f.description.trim() || null,
        planned_paise: toPaise(f.planned),
        default_expense_type_id: f.expenseTypeId || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorFrom(await res.json().catch(() => null)));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium"
        style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
      >
        <Plus size={14} aria-hidden /> Add a line item
      </button>
    );
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-2 text-xs text-text-muted">
        {availableToPlanPaise > 0
          ? `${formatPaise(availableToPlanPaise)} of the allocation is still unplanned.`
          : "The whole allocation is already planned — this will be refused unless something else shrinks first."}
      </p>
      <Form
        initial={EMPTY}
        expenseTypes={expenseTypes}
        submitLabel="Create"
        busy={busy}
        error={error}
        onSubmit={create}
        onCancel={() => { setOpen(false); setError(null); }}
      />
    </div>
  );
}

export function LineItemActions({
  item, expenseTypes,
}: {
  item: {
    id: string; name: string; description: string | null;
    plannedPaise: number; defaultExpenseTypeId: string | null; status: string;
  };
  expenseTypes: ExpenseTypeOption[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(f: Fields) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/line-items/${item.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: f.name.trim(),
        description: f.description.trim() || null,
        planned_paise: toPaise(f.planned),
        default_expense_type_id: f.expenseTypeId || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorFrom(await res.json().catch(() => null)));
      return;
    }
    setEditing(false);
    router.refresh();
  }

  async function transition(action: "CLOSE" | "REOPEN") {
    const reason = window.prompt(
      action === "CLOSE"
        ? "Closing releases the unspent balance back to the department. Why is it closing?"
        : "Why is this reopening?",
    );
    if (!reason?.trim()) return;

    setBusy(true);
    const res = await fetch(`/api/v1/line-items/${item.id}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, reason: reason.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorFrom(await res.json().catch(() => null)));
      return;
    }
    router.refresh();
  }

  if (editing) {
    return (
      <Form
        initial={{
          name: item.name,
          description: item.description ?? "",
          planned: (item.plannedPaise / 100).toString(),
          expenseTypeId: item.defaultExpenseTypeId ?? "",
        }}
        expenseTypes={expenseTypes}
        submitLabel="Save"
        busy={busy}
        error={error}
        onSubmit={save}
        onCancel={() => { setEditing(false); setError(null); }}
      />
    );
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {error && (
        <span className="mr-1 text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</span>
      )}
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Edit this line item"
        aria-label={`Edit ${item.name}`}
        className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-text"
      >
        <Pencil size={14} aria-hidden />
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => transition(item.status === "CLOSED" ? "REOPEN" : "CLOSE")}
        title={item.status === "CLOSED" ? "Reopen this line item" : "Close it — no new requests can attach"}
        aria-label={`${item.status === "CLOSED" ? "Reopen" : "Close"} ${item.name}`}
        className="rounded-lg p-1.5 text-text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
      >
        {item.status === "CLOSED" ? <RotateCcw size={14} aria-hidden /> : <X size={14} aria-hidden />}
      </button>
    </div>
  );
}
