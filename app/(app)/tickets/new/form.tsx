"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Required } from "@/components/ui";

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const;

export interface Option { id: string; name: string }
export interface LabelOption extends Option { color: string }

/** A half-written ticket. Everything on it is a suggestion the person can overwrite. */
export interface TemplateOption {
  id: string;
  name: string;
  summary: string | null;
  target_department_id: string | null;
  title: string | null;
  body: string | null;
  priority: string;
  location: string | null;
  due_in_hours: number | null;
  project_id: string | null;
  cycle_id: string | null;
  label_ids: string[];
}

/** `datetime-local` wants a local wall-clock string, not an ISO instant. */
function localDateTime(hoursFromNow: number): string {
  const t = new Date(Date.now() + hoursFromNow * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
    + `T${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/**
 * PRD 9.5 — one screen, one ask. Title, who, what by when.
 *
 * The planning fields sit under a disclosure rather than in the main flow. Most
 * tickets are raised by somebody in a hurry who needs a van at four o'clock, and
 * making them scroll past a project picker to reach the due date would cost more
 * than the filing is worth. Anything skipped here can be set from the board later.
 */
export function TicketForm({
  departments, labels, projects, cycles, parents, templates = [], fixedTarget = false,
}: {
  departments: Option[];
  /** A member raises with their own head — one destination, so it is stated, not picked. */
  fixedTarget?: boolean;
  labels: LabelOption[];
  projects: Option[];
  cycles: Option[];
  /** Tickets that could be this one's parent — top-level, still open. */
  parents: { id: string; humanId: string; title: string }[];
  /** Already filtered to what this caller may raise; see `listTemplates`. */
  templates?: TemplateOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [chosenLabels, setChosenLabels] = useState<string[]>([]);
  const [tpl, setTpl] = useState<TemplateOption | null>(null);

  /*
   * Picking a template re-mounts the form (`key` below) so every field takes its
   * new default. An effect that reached in and set each input would fight whatever
   * the person had already typed; throwing the form away and rebuilding it says
   * plainly that starting from a template starts over.
   */
  function choose(id: string) {
    const next = templates.find((t) => t.id === id) ?? null;
    setTpl(next);
    setChosenLabels(next?.label_ids ?? []);
    setError(null);
    if (next && (next.project_id || next.cycle_id || next.label_ids.length > 0)) setPlanning(true);
  }

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
    <>
      {templates.length > 0 && (
        <div className="mb-5">
          <span className="text-sm text-text-soft">Start from a template</span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <TemplateChip on={tpl === null} onClick={() => choose("")}>Blank</TemplateChip>
            {templates.map((t) => (
              <TemplateChip key={t.id} on={tpl?.id === t.id} onClick={() => choose(t.id)} title={t.summary ?? undefined}>
                {t.name}
              </TemplateChip>
            ))}
          </div>
          {tpl?.summary && <p className="mt-2 text-xs text-text-muted">{tpl.summary}</p>}
        </div>
      )}

    <form key={tpl?.id ?? "blank"} onSubmit={submit} className="space-y-4">
      <Field label="What do you need?" hint="Short and specific — 80 characters." required>
        <input name="title" required minLength={5} maxLength={80} defaultValue={tpl?.title ?? ""} className={INPUT} />
      </Field>

      <Field label="Details" required>
        <textarea name="description" required minLength={5} maxLength={2000} rows={4}
          defaultValue={tpl?.body ?? ""} className={INPUT} />
      </Field>

      {fixedTarget ? (
        <input type="hidden" name="target_department_id" value={departments[0]?.id ?? ""} />
      ) : (
        <Field label="Which department?" required>
          <select name="target_department_id" required className={INPUT}
            defaultValue={tpl?.target_department_id ?? ""}>
            <option value="" disabled>Choose a department</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </Field>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Needed by" required hint={tpl?.due_in_hours ? `The template suggests ${tpl.due_in_hours}h` : undefined}>
          <input name="due_at" type="datetime-local" required className={INPUT}
            defaultValue={tpl?.due_in_hours ? localDateTime(tpl.due_in_hours) : ""} />
        </Field>
        <Field label="Priority">
          <select name="priority" defaultValue={tpl?.priority ?? "MEDIUM"} className={INPUT}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{p.toLowerCase()}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Where" hint="Optional">
          <input name="location" maxLength={200} defaultValue={tpl?.location ?? ""} className={INPUT} />
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
                <select name="project_id" defaultValue={tpl?.project_id ?? ""} className={INPUT}>
                  <option value="">No project</option>
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
              <Field label="Cycle" hint="Optional">
                <select name="cycle_id" defaultValue={tpl?.cycle_id ?? ""} className={INPUT}>
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
        style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
      >
        {busy ? "Sending…" : "Send request"}
      </button>

      {error && (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}
    </form>
    </>
  );
}

function TemplateChip({
  on, onClick, title, children,
}: {
  on: boolean; onClick: () => void; title?: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button" aria-pressed={on} onClick={onClick} title={title}
      className="rounded-full px-3 py-1.5 text-xs"
      style={on
        ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)", border: "1px solid var(--yg-accent)" }
        : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
    >
      {children}
    </button>
  );
}

const INPUT = "mt-1 w-full rounded-lg px-3 py-2.5 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

function Field({
  label, hint, required, children,
}: { label: string; hint?: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-baseline gap-2 text-sm text-text-soft">
        {label}
        {required && <Required />}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </div>
  );
}
