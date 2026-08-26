"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export interface Option { id: string; name: string }
export interface LabelOption extends Option { color: string }

/**
 * PRD 9.5 — one screen, one ask. Title, who, what by when.
 *
 * The planning fields sit under a disclosure rather than in the main flow. Most
 * tickets are raised by somebody in a hurry who needs a van at four o'clock, and
 * making them scroll past a project picker to reach the due date would cost more
 * than the filing is worth. Anything skipped here can be set from the board later.
 */
export function TicketForm({
  departments, labels, projects, cycles, parents, fixedTarget = false,
}: {
  departments: Option[];
  /** A member raises with their own head — one destination, so it is stated, not picked. */
  fixedTarget?: boolean;
  labels: LabelOption[];
  projects: Option[];
  cycles: Option[];
  /** Tickets that could be this one's parent — top-level, still open. */
  parents: { id: string; humanId: string; title: string }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [chosenLabels, setChosenLabels] = useState<string[]>([]);

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
        label_ids: chosenLabels.length ? chosenLabels : undefined,
        project_id: String(f.get("project_id") ?? "") || null,
        cycle_id: String(f.get("cycle_id") ?? "") || null,
        parent_id: String(f.get("parent_id") ?? "") || null,
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
    return (
      <p className="text-[13.5px] text-text-muted">
        {fixedTarget
          ? "Your department has not been set up yet, so there is nobody to raise this with."
          : "There is no other department to ask."}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="What do you need?" hint="Short and specific — 80 characters.">
        <input name="title" required minLength={5} maxLength={80} className={INPUT} />
      </Field>

      <Field label="Details">
        <textarea name="description" required minLength={5} maxLength={2000} rows={4} className={INPUT} />
      </Field>

      {fixedTarget ? (
        <input type="hidden" name="target_department_id" value={departments[0]?.id ?? ""} />
      ) : (
        <Field label="Which department?">
          <select name="target_department_id" required className={INPUT} defaultValue="">
            <option value="" disabled>Choose a department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      )}

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

      <div>
        <button
          type="button"
          onClick={() => setPlanning((v) => !v)}
          className="text-xs text-text-muted underline underline-offset-2"
        >
          {planning ? "Hide" : "Add"} labels, project, cycle or a parent ticket
        </button>

        {planning && (
          <div className="mt-3 space-y-4 rounded-xl p-3" style={{ border: "1px solid var(--yg-surface-2)" }}>
            {labels.length > 0 && (
              <div>
                <span className="text-sm text-text-soft">Labels</span>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {labels.map((l) => {
                    const on = chosenLabels.includes(l.id);
                    return (
                      <button
                        key={l.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setChosenLabels(
                          on ? chosenLabels.filter((x) => x !== l.id) : [...chosenLabels, l.id],
                        )}
                        className="rounded-full px-2.5 py-1 text-xs"
                        style={on
                          ? { background: `${l.color}22`, color: l.color, border: `1px solid ${l.color}` }
                          : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-muted)" }}
                      >
                        {l.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Project" hint="Optional">
                <select name="project_id" defaultValue="" className={INPUT}>
                  <option value="">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Cycle" hint="Optional">
                <select name="cycle_id" defaultValue="" className={INPUT}>
                  <option value="">No cycle</option>
                  {cycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>

            <Field label="Part of" hint="Optional — makes this a sub-ticket. One level only.">
              <select name="parent_id" defaultValue="" className={INPUT}>
                <option value="">Not a sub-ticket</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>{p.humanId} — {p.title}</option>
                ))}
              </select>
            </Field>
          </div>
        )}
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
