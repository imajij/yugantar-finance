"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Plus, RotateCcw, X } from "lucide-react";
import { formatPaise } from "@/lib/money";
import { Button, IconButton } from "@/components/ui";
import { ConfirmWithReason } from "@/components/confirm";

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
  "w-full rounded-[var(--r-control)] px-3.5 py-2.5 text-[13.5px] bg-[var(--yg-bg-app)] "
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
        <Button
          tone="primary"
          disabled={busy || f.name.trim().length < 2 || paise === null}
          onClick={() => onSubmit(f)}
        >
          {busy ? "Saving…" : submitLabel}
        </Button>
        <Button tone="ghost" onClick={onCancel}>Cancel</Button>
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
      <Button tone="primary" onClick={() => setOpen(true)}>
        <Plus size={16} aria-hidden /> New line item
      </Button>
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
  const [confirming, setConfirming] = useState<"CLOSE" | "REOPEN" | null>(null);
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

  async function transition(reason: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/line-items/${item.id}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: confirming, reason }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorFrom(await res.json().catch(() => null)));
      return;
    }
    setConfirming(null);
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

  const closing = item.status !== "CLOSED";

  return (
    <div className="flex items-center justify-end gap-1.5">
      {error && !confirming && (
        <span className="mr-1 text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</span>
      )}
      <IconButton label={`Edit ${item.name}`} onClick={() => setEditing(true)}>
        <Pencil size={16} aria-hidden />
      </IconButton>
      <IconButton
        label={closing ? `Close ${item.name}` : `Reopen ${item.name}`}
        disabled={busy}
        onClick={() => setConfirming(closing ? "CLOSE" : "REOPEN")}
      >
        {closing ? <X size={16} aria-hidden /> : <RotateCcw size={16} aria-hidden />}
      </IconButton>

      <ConfirmWithReason
        open={confirming !== null}
        title={closing ? `Close “${item.name}”?` : `Reopen “${item.name}”?`}
        consequence={
          closing
            ? <>No new request can attach to it, and its unspent balance returns to the
                department&rsquo;s unplanned buffer. Anything already approved against it stays.</>
            : <>Requests can attach to it again, and its planned amount comes back out of the
                department&rsquo;s buffer.</>
        }
        confirmLabel={closing ? "Close it" : "Reopen it"}
        cancelLabel="Leave it as it is"
        reason={{
          label: closing ? "Why it is closing" : "Why it is reopening",
          placeholder: closing ? "Sound is fully delivered and paid." : "One more hire came up.",
        }}
        busy={busy}
        error={error}
        onConfirm={transition}
        onCancel={() => { setConfirming(null); setError(null); }}
      />
    </div>
  );
}
