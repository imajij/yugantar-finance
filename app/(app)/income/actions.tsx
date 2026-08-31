"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Required } from "@/components/ui";

const INPUT = "mt-1 w-full rounded-lg px-3 py-2.5 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

const TYPES = [
  ["SPONSORSHIP_CASH", "Sponsorship (cash)"],
  ["SPONSORSHIP_IN_KIND", "Sponsorship (in kind)"],
  ["EVENT_TICKETS", "Event tickets"],
  ["COLLEGE_GRANT", "College grant"],
  ["OTHER", "Other"],
] as const;

export function NewIncomeForm({ departments }: { departments: { id: string; name: string }[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/v1/income", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: f.get("type"),
        source_name: f.get("source_name"),
        owning_department_id: String(f.get("owning_department_id") ?? "") || null,
        pledged_paise: Math.round(Number(f.get("pledged") ?? 0) * 100),
        pledged_on: String(f.get("pledged_on") ?? "") || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? "Could not record that");
      return;
    }
    (e.target as HTMLFormElement).reset();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="flex items-baseline gap-2 text-sm text-text-soft">Source <Required /></label>
          <input name="source_name" required minLength={2} maxLength={160} className={INPUT} />
        </div>
        <div>
          <label className="text-sm text-text-soft">Type</label>
          <select name="type" defaultValue="SPONSORSHIP_CASH" className={INPUT}>
            {TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="flex items-baseline gap-2 text-sm text-text-soft">Pledged (₹) <Required /></label>
          <input name="pledged" type="number" step="0.01" min="0" required className={INPUT} />
        </div>
        <div>
          <label className="text-sm text-text-soft">Pledged on</label>
          <input name="pledged_on" type="date" className={INPUT} />
        </div>
        <div>
          <label className="text-sm text-text-soft">Owning department</label>
          <select name="owning_department_id" defaultValue="" className={INPUT}>
            <option value="">Fest-wide</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>
      <button type="submit" disabled={busy}
        className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}>
        {busy ? "Saving…" : "Record"}
      </button>
      {error && <p className="text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </form>
  );
}

/** Money in, or a pledge that is never going to arrive. */
export function IncomeActions({
  id, status, outstandingPaise,
}: { id: string; status: string; outstandingPaise: number }) {
  const router = useRouter();
  const [open, setOpen] = useState<"tranche" | "writeoff" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? "That did not work");
      return;
    }
    setOpen(null);
    router.refresh();
  }

  const writtenOff = status === "WRITTEN_OFF";

  return (
    <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--yg-surface-2)" }}>
      <div className="flex flex-wrap gap-2">
        {!writtenOff && outstandingPaise > 0 && (
          <button onClick={() => setOpen(open === "tranche" ? null : "tranche")}
            className="rounded-full px-3.5 py-1.5 text-xs font-medium"
            style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}>
            Record money received
          </button>
        )}
        {!writtenOff && outstandingPaise > 0 && (
          <button onClick={() => setOpen(open === "writeoff" ? null : "writeoff")}
            className="rounded-full px-3.5 py-1.5 text-xs"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}>
            Write off
          </button>
        )}
        {writtenOff && (
          <button disabled={busy}
            onClick={() => post(`/api/v1/income/${id}/transitions`, { action: "REINSTATE" })}
            className="rounded-full px-3.5 py-1.5 text-xs"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}>
            Reinstate
          </button>
        )}
      </div>

      {open === "tranche" && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            post(`/api/v1/income/${id}/tranches`, {
              amount_paise: Math.round(Number(f.get("amount")) * 100),
              received_on: f.get("received_on"),
              reference: String(f.get("reference") ?? "") || null,
            });
          }}
        >
          <input name="amount" type="number" step="0.01" min="0.01" required placeholder="Amount ₹"
            className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }} />
          <input name="received_on" type="date" required
            className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }} />
          <input name="reference" placeholder="Reference" maxLength={80}
            className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }} />
          <button type="submit" disabled={busy}
            className="rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
            style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}

      {open === "writeoff" && (
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            post(`/api/v1/income/${id}/transitions`, { action: "WRITE_OFF", reason: f.get("reason") });
          }}
        >
          <input name="reason" required minLength={3} maxLength={500} placeholder="Why is this not coming?"
            className="min-w-64 flex-1 rounded-lg px-3 py-2 text-sm"
            style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }} />
          <button type="submit" disabled={busy}
            className="rounded-full px-4 py-2 text-sm disabled:opacity-50"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}>
            {busy ? "Saving…" : "Write off"}
          </button>
        </form>
      )}

      {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
    </div>
  );
}
