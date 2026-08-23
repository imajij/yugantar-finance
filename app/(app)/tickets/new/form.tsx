"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

/** PRD 9.5 — one screen, one ask. Title, who, what by when. */
export function TicketForm({ departments }: { departments: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const cost = String(f.get("estimated_cost") ?? "").trim();

    const res = await fetch("/api/v1/tickets", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        title: f.get("title"),
        description: f.get("description"),
        target_department_id: f.get("target_department_id"),
        due_at: new Date(String(f.get("due_at"))).toISOString(),
        priority: f.get("priority"),
        location: String(f.get("location") ?? "").trim() || null,
        estimated_cost_paise: cost ? Math.round(Number(cost) * 100) : null,
      }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "Could not create that ticket");
      return;
    }
    router.push(`/tickets/${json.id}`);
  }

  if (departments.length === 0) {
    return <p className="text-sm text-text-muted">There is no other department to ask.</p>;
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="What do you need?" hint="Short and specific — 80 characters.">
        <input name="title" required minLength={5} maxLength={80} className={INPUT} />
      </Field>

      <Field label="Details">
        <textarea name="description" required minLength={5} maxLength={2000} rows={4} className={INPUT} />
      </Field>

      <Field label="Which department?">
        <select name="target_department_id" required className={INPUT} defaultValue="">
          <option value="" disabled>Choose a department</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Needed by">
          <input name="due_at" type="datetime-local" required className={INPUT} />
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue="MEDIUM" className={INPUT}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Where" hint="Optional">
          <input name="location" maxLength={200} className={INPUT} />
        </Field>
        <Field label="Estimated cost (₹)" hint="Optional — for visibility, not a budget hold">
          <input name="estimated_cost" type="number" step="0.01" min="0" className={INPUT} />
        </Field>
      </div>

      <button
        type="submit" disabled={busy}
        className="rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
      >
        {busy ? "Sending…" : "Send request"}
      </button>

      {error && (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}
    </form>
  );
}

const INPUT = "mt-1 w-full rounded-lg px-3 py-2.5 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm text-text-soft">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
