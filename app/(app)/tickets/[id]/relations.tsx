"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { IconButton } from "@/components/ui";
import { chipStyle, stateLabel } from "@/lib/state-chip";

export interface Relation {
  link_id: string;
  relation: string;
  id: string;
  human_id: string;
  title: string;
  status: string;
  is_open: boolean;
}

/**
 * How each relation reads on screen. The stored row is always one direction; the
 * far end is rendered from the same row, which is why "blocks" and "blocked by"
 * both appear here and only one of them exists in the database.
 */
const LABEL: Record<string, string> = {
  BLOCKED_BY: "Blocked by",
  BLOCKS: "Blocks",
  DUPLICATED_BY: "Duplicated by",
  DUPLICATES: "Duplicates",
  RELATED: "Related",
};

/** The order they matter in. What is holding this up comes before what it resembles. */
const ORDER = ["BLOCKED_BY", "BLOCKS", "DUPLICATES", "DUPLICATED_BY", "RELATED"];

const CHOICES = [
  { value: "BLOCKS", label: "blocks" },
  { value: "BLOCKED_BY", label: "is blocked by" },
  { value: "DUPLICATES", label: "duplicates" },
  { value: "RELATED", label: "relates to" },
] as const;

export function Relations({
  ticketId, relations, candidates, canEdit,
}: {
  ticketId: string;
  relations: Relation[];
  /** Live tickets this one could be related to. Excludes itself. */
  candidates: { id: string; humanId: string; title: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const grouped = ORDER
    .map((r) => ({ relation: r, items: relations.filter((x) => x.relation === r) }))
    .filter((g) => g.items.length > 0);

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const choice = String(f.get("relation"));
    const other = String(f.get("to_id"));
    if (!other) return;

    /*
     * "is blocked by" is not a relation, it is the other one read backwards — so
     * the request is sent from the other ticket. One row, one direction, and the
     * person filling in the form never has to think about which end it lives on.
     */
    const [from, to, relation] = choice === "BLOCKED_BY"
      ? [other, ticketId, "BLOCKS"]
      : [ticketId, other, choice];

    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/tickets/${from}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to_type: "TICKET", to_id: to, relation }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) { setError(json?.error?.message ?? "Could not link those"); return; }
    setAdding(false);
    router.refresh();
  }

  async function remove(linkId: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/tickets/${ticketId}/links/${linkId}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json().catch(() => null))?.error?.message ?? "Could not remove that");
      return;
    }
    router.refresh();
  }

  if (relations.length === 0 && !canEdit) return null;

  return (
    <>
      {grouped.map((g) => (
        <div key={g.relation} className="mt-3 first:mt-0">
          <p className="meta-label">{LABEL[g.relation]}</p>
          <ul className="mt-1.5 space-y-1.5">
            {g.items.map((r) => (
              <li key={r.link_id} className="flex items-center gap-2 text-sm">
                <span className="rounded-full px-2 py-0.5 text-xs font-medium" style={chipStyle(r.status)}>
                  {stateLabel(r.status)}
                </span>
                <Link href={`/tickets/${r.id}`} className="min-w-0 flex-1 truncate hover:text-lime">
                  <span className="tnum mr-1.5 text-xs text-text-muted">{r.human_id}</span>
                  {r.title}
                </Link>
                {canEdit && (
                  <IconButton label={`Remove link to ${r.human_id}`} onClick={() => remove(r.link_id)} disabled={busy}>
                    <X size={14} aria-hidden />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}

      {canEdit && (adding ? (
        <form onSubmit={add} className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-text-soft">This ticket</span>
          <select name="relation" defaultValue="BLOCKED_BY" className={FIELD}>
            {CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <select name="to_id" required defaultValue="" className={`${FIELD} min-w-0 flex-1`}>
            <option value="" disabled>Choose a ticket</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>{c.humanId} — {c.title}</option>
            ))}
          </select>
          <button
            type="submit" disabled={busy}
            className="rounded-full px-3.5 py-1.5 text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
          >
            Link
          </button>
          <button type="button" onClick={() => { setAdding(false); setError(null); }}
            className="text-xs text-text-muted underline underline-offset-2">
            Cancel
          </button>
        </form>
      ) : (
        <button onClick={() => setAdding(true)} className="mt-3 text-sm" style={{ color: "var(--yg-pink)" }}>
          + Link another ticket
        </button>
      ))}

      {candidates.length === 0 && adding && (
        <p className="mt-2 text-xs text-text-muted">There is no other open ticket you can see to link to.</p>
      )}

      {error && (
        <p className="mt-2 rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}
    </>
  );
}

const FIELD =
  "rounded-lg px-2.5 py-1.5 text-sm bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";
