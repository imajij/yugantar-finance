"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { IconButton } from "@/components/ui";
import { ConfirmWithReason } from "@/components/confirm";

/**
 * Managing the board's vocabulary: labels, projects, cycles.
 *
 * Kept off the board itself deliberately. Linear puts label creation inside the
 * label picker, which is fast and also how you end up with "sound", "Sound" and
 * "sound-system" by the second day of a fest. Making the vocabulary a place you go
 * to, rather than something you can produce by accident mid-triage, is worth the
 * extra click for the four days this has to hold up.
 */

const FIELD =
  "rounded-lg px-2.5 py-1.5 text-sm bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

const PALETTE = [
  "#d2fc3c", "#eece00", "#f5449e", "#7fd5ff", "#b39dff",
  "#90ee90", "#ee9090", "#f5c542", "#8b8ba7",
];

const message = (b: unknown) =>
  (b as { error?: { message?: string } })?.error?.message ?? "That did not work";

function useWriter() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(url: string, method: string, body?: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method,
      ...(body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return false; }
    router.refresh();
    return true;
  }

  return { busy, error, setError, send };
}

/* -------------------------------------------------------------------- labels */

export function Labels({
  labels,
}: {
  labels: { id: string; name: string; color: string; ticket_count: number }[];
}) {
  const { busy, error, send } = useWriter();
  const [name, setName] = useState("");
  const [color, setColor] = useState(PALETTE[0]);
  const [doomed, setDoomed] = useState<Doomed | null>(null);

  return (
    <section>
      <h2 className="font-display mb-1 text-lg">Labels</h2>
      <p className="mb-3 text-xs text-text-muted">
        Shared across every department, so &ldquo;Needs a van&rdquo; means the same thing on
        Logistics&rsquo; board as on Tech&rsquo;s.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New label"
          className={FIELD}
          aria-label="New label name"
        />
        <div className="flex gap-1" role="group" aria-label="Label colour">
          {PALETTE.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
              aria-pressed={color === c}
              className="size-6 rounded-full"
              style={{ background: c, outline: color === c ? "2px solid var(--yg-text)" : "none", outlineOffset: 2 }}
            />
          ))}
        </div>
        <button
          type="button"
          disabled={busy || name.trim().length < 2}
          onClick={async () => {
            if (await send("/api/v1/ticket-labels", "POST", { name: name.trim(), color })) setName("");
          }}
          className="rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
        >
          Add
        </button>
      </div>

      {error && <p className="mb-2 text-xs" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex flex-wrap gap-2">
        {labels.length === 0 && <p className="text-sm text-text-muted">No labels yet.</p>}
        {labels.map((l) => (
          <span
            key={l.id}
            className="flex items-center gap-2 rounded-full py-1 pr-1.5 pl-2.5 text-xs"
            style={{ background: `${l.color}22`, color: l.color, border: `1px solid ${l.color}55` }}
          >
            {l.name}
            <span className="tnum opacity-60">{l.ticket_count}</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => setDoomed({
                kind: "label", id: l.id, name: l.name,
                consequence: l.ticket_count > 0
                  ? `It comes off ${l.ticket_count} ticket${l.ticket_count === 1 ? "" : "s"}. Nothing else about them changes.`
                  : "Nothing is using it.",
              })}
              aria-label={`Delete ${l.name}`}
              className="rounded-full p-0.5 hover:bg-surface-2"
            >
              <Trash2 size={11} aria-hidden />
            </button>
          </span>
        ))}
      </div>

      <RetireDialog
        doomed={doomed}
        busy={busy}
        error={error}
        onConfirm={() => doomed && send(`/api/v1/ticket-labels/${doomed.id}`, "DELETE").then(() => setDoomed(null))}
        onCancel={() => setDoomed(null)}
      />
    </section>
  );
}

/**
 * Deleting a piece of the board's vocabulary. It takes no written reason — a label
 * carries no financial record — but it does state what goes with it, because
 * "delete?" does not tell you it is about to come off eleven tickets.
 */
interface Doomed { kind: "label" | "project" | "cycle"; id: string; name: string; consequence: string }

function RetireDialog({
  doomed, busy, error, onConfirm, onCancel,
}: {
  doomed: Doomed | null; busy: boolean; error: string | null;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <ConfirmWithReason
      open={doomed !== null}
      title={doomed ? `Delete “${doomed.name}”?` : ""}
      consequence={doomed?.consequence ?? ""}
      confirmLabel="Delete it"
      cancelLabel="Keep it"
      tone="destructive"
      busy={busy}
      error={error}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

/* ------------------------------------------------------------------ projects */

export function Projects({
  projects, members,
}: {
  projects: {
    id: string; name: string; status: string; lead_name: string | null;
    starts_on: string | null; ends_on: string | null;
    ticket_count: number; done_count: number;
  }[];
  members: { id: string; name: string }[];
}) {
  const { busy, error, send } = useWriter();
  const [name, setName] = useState("");
  const [lead, setLead] = useState("");
  const [doomed, setDoomed] = useState<Doomed | null>(null);

  return (
    <section>
      <h2 className="font-display mb-1 text-lg">Projects</h2>
      <p className="mb-3 text-xs text-text-muted">
        A deliverable several departments contribute to — &ldquo;Main stage build&rdquo;,
        &ldquo;Sponsor lounge&rdquo;. Deleting one leaves its tickets alone; they are simply unfiled.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project"
          className={FIELD}
          aria-label="New project name"
        />
        <select value={lead} onChange={(e) => setLead(e.target.value)} className={FIELD} aria-label="Project lead">
          <option value="">No lead</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button
          type="button"
          disabled={busy || name.trim().length < 2}
          onClick={async () => {
            if (await send("/api/v1/projects", "POST", { name: name.trim(), lead_id: lead || null })) {
              setName("");
              setLead("");
            }
          }}
          className="rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
        >
          Add
        </button>
      </div>

      {error && <p className="mb-2 text-xs" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="space-y-2">
        {projects.length === 0 && <p className="text-sm text-text-muted">No projects yet.</p>}
        {projects.map((p) => (
          <div
            key={p.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2.5"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
          >
            <div className="min-w-0">
              <p className="text-sm">{p.name}</p>
              <p className="text-xs text-text-muted">
                {p.lead_name ?? "no lead"}
                {" · "}
                <span className="tnum">{p.done_count}/{p.ticket_count}</span> done
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={p.status}
                disabled={busy}
                onChange={(e) => send(`/api/v1/projects/${p.id}`, "PATCH", { status: e.target.value })}
                className={`${FIELD} text-xs`}
                aria-label={`Status of ${p.name}`}
              >
                {["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"].map((s) => (
                  <option key={s} value={s}>{s[0] + s.slice(1).toLowerCase()}</option>
                ))}
              </select>
              <IconButton
                label={`Retire ${p.name}`}
                disabled={busy}
                onClick={() => setDoomed({
                  kind: "project", id: p.id, name: p.name,
                  consequence: `Its ${p.ticket_count} ticket${p.ticket_count === 1 ? "" : "s"} stay on their boards, unfiled. A project is a grouping, not an owner.`,
                })}
              >
                <Trash2 size={16} aria-hidden />
              </IconButton>
            </div>
          </div>
        ))}
      </div>

      <RetireDialog
        doomed={doomed}
        busy={busy}
        error={error}
        onConfirm={() => doomed && send(`/api/v1/projects/${doomed.id}`, "DELETE").then(() => setDoomed(null))}
        onCancel={() => setDoomed(null)}
      />
    </section>
  );
}

/* -------------------------------------------------------------------- cycles */

export function Cycles({
  cycles,
}: {
  cycles: {
    id: string; name: string; starts_on: string; ends_on: string;
    is_current: boolean; ticket_count: number; done_count: number;
  }[];
}) {
  const { busy, error, send } = useWriter();
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [doomed, setDoomed] = useState<Doomed | null>(null);

  return (
    <section>
      <h2 className="font-display mb-1 text-lg">Cycles</h2>
      <p className="mb-3 text-xs text-text-muted">
        A window everybody plans against — &ldquo;Setup week&rdquo;, &ldquo;Fest days&rdquo;. Useful
        for the question a due date cannot answer: what is left for <em>this</em> stretch.
      </p>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New cycle"
          className={FIELD} aria-label="New cycle name" />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className={FIELD} aria-label="Cycle start" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
          className={FIELD} aria-label="Cycle end" />
        <button
          type="button"
          disabled={busy || name.trim().length < 2 || !from || !to}
          onClick={async () => {
            if (await send("/api/v1/cycles", "POST", { name: name.trim(), starts_on: from, ends_on: to })) {
              setName(""); setFrom(""); setTo("");
            }
          }}
          className="rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-40"
          style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
        >
          Add
        </button>
      </div>

      {error && <p className="mb-2 text-xs" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="space-y-2">
        {cycles.length === 0 && <p className="text-sm text-text-muted">No cycles yet.</p>}
        {cycles.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-3 py-2.5"
            style={{
              background: "var(--yg-surface)",
              border: `1px solid ${c.is_current ? "var(--yg-lime)" : "var(--yg-surface-2)"}`,
            }}
          >
            <div>
              <p className="text-sm">
                {c.name}
                {c.is_current && <span className="ml-2 text-xs text-lime">current</span>}
              </p>
              <p className="tnum text-xs text-text-muted">
                {c.starts_on} → {c.ends_on} · {c.done_count}/{c.ticket_count} done
              </p>
            </div>
            <IconButton
              label={`Delete ${c.name}`}
              disabled={busy}
              onClick={() => setDoomed({
                kind: "cycle", id: c.id, name: c.name,
                consequence: `Its ${c.ticket_count} ticket${c.ticket_count === 1 ? "" : "s"} stay put and lose the cycle.`,
              })}
            >
              <Trash2 size={16} aria-hidden />
            </IconButton>
          </div>
        ))}
      </div>

      <RetireDialog
        doomed={doomed}
        busy={busy}
        error={error}
        onConfirm={() => doomed && send(`/api/v1/cycles/${doomed.id}`, "DELETE").then(() => setDoomed(null))}
        onCancel={() => setDoomed(null)}
      />
    </section>
  );
}
