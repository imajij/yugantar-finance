"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPaise } from "@/lib/money";
import { Required } from "@/components/ui";
import { FileUpload, type Uploaded } from "@/components/file-upload";

const INPUT = "mt-1 w-full rounded-lg px-3 py-2.5 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

interface Props {
  vendors: { id: string; name: string }[];
  lineItems: { id: string; name: string; departmentName: string; availablePaise: number }[];
  canApprove: boolean;
  /** Finance may charge any department; the list is then grouped by department. */
  anyDepartment: boolean;
}

/**
 * PRD 7.3 — the MVP shape is advance + balance. The split is a percentage so the
 * two milestones always add up to the total, which the service insists on.
 */
export function VendorRequestForm({ vendors, lineItems, canApprove, anyDepartment }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState("");
  const [advancePct, setAdvancePct] = useState(50);
  const [lineItemId, setLineItemId] = useState("");
  const [documents, setDocuments] = useState<Uploaded[]>([]);

  const totalPaise = Math.round(Number(total || 0) * 100);
  const advancePaise = Math.round((totalPaise * advancePct) / 100);
  const balancePaise = totalPaise - advancePaise;
  const chosen = lineItems.find((i) => i.id === lineItemId);
  const overAvailable = chosen ? totalPaise > chosen.availablePaise : false;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);

    const res = await fetch("/api/v1/vendor-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        vendor_id: f.get("vendor_id"),
        line_item_id: f.get("line_item_id"),
        description: f.get("description"),
        total_value_paise: totalPaise,
        milestones: [
          { kind: "ADVANCE", planned_paise: advancePaise },
          { kind: "BALANCE", planned_paise: balancePaise },
        ],
        expected_delivery_on: String(f.get("expected_delivery_on") ?? "") || null,
        attachment_ids: documents.map((d) => d.id),
        submit: true,
      }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "Could not raise that request");
      return;
    }
    router.push(`/vendors/requests/${json.id}`);
  }

  if (lineItems.length === 0) {
    return (
      <p className="text-sm text-text-muted">
        {anyDepartment
          ? "No department has an open line item to charge this to yet."
          : "Your department has no open line items to charge this to."}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Vendor" required>
        <select name="vendor_id" required defaultValue="" className={INPUT}>
          <option value="" disabled>Choose a vendor</option>
          {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Field>

      <Field label="What are they supplying?" required>
        <textarea name="description" required minLength={5} maxLength={1000} rows={3} className={INPUT} />
      </Field>

      <Field
        label="Line item"
        required
        hint={chosen
          ? `${anyDepartment ? `${chosen.departmentName} · ` : ""}${formatPaise(chosen.availablePaise)} available`
          : anyDepartment ? "Any department's — the request is charged to that department's budget." : undefined}
      >
        <select
          name="line_item_id" required value={lineItemId} className={INPUT}
          onChange={(e) => setLineItemId(e.target.value)}
        >
          <option value="" disabled>Choose a line item</option>
          {anyDepartment
            ? [...new Set(lineItems.map((i) => i.departmentName))].map((dept) => (
              <optgroup key={dept} label={dept}>
                {lineItems.filter((i) => i.departmentName === dept).map((i) => (
                  <option key={i.id} value={i.id}>{i.name} — {formatPaise(i.availablePaise)} left</option>
                ))}
              </optgroup>
            ))
            : lineItems.map((i) => (
              <option key={i.id} value={i.id}>{i.name} — {formatPaise(i.availablePaise)} left</option>
            ))}
        </select>
      </Field>

      <Field label="Total value (₹)" required>
        <input
          name="total_value" type="number" step="0.01" min="0.01" required
          value={total} onChange={(e) => setTotal(e.target.value)} className={INPUT}
        />
      </Field>

      {overAvailable && (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          This is more than the line item has available. Finance cannot approve it until the
          budget is moved or the line item is topped up.
        </p>
      )}

      <Field label={`Advance ${advancePct}% / balance ${100 - advancePct}%`}>
        <input
          type="range" min={0} max={100} step={5} value={advancePct}
          onChange={(e) => setAdvancePct(Number(e.target.value))}
          className="mt-2 w-full"
        />
        {totalPaise > 0 && (
          <p className="tnum mt-1 text-xs text-text-muted">
            advance {formatPaise(advancePaise)} · balance {formatPaise(balancePaise)}
          </p>
        )}
      </Field>

      <Field label="Expected delivery" hint="Optional — drives the overdue-delivery flag.">
        <input name="expected_delivery_on" type="date" className={INPUT} />
      </Field>

      <FileUpload
        files={documents}
        onChange={setDocuments}
        max={10}
        purpose="QUOTE"
        label="Quote, invoice or MoU"
        hint="What the vendor sent, so whoever approves can check the amount. JPG, PNG, HEIC or PDF, up to 10 MB each. More can be added later from the request."
      />

      <button
        type="submit" disabled={busy || totalPaise <= 0}
        className="rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
      >
        {busy ? "Sending…" : "Submit for approval"}
      </button>

      {canApprove && (
        <p className="text-xs text-text-muted">
          You can approve this yourself once it is raised, with a note saying why — Management
          is told when you do.
        </p>
      )}

      {error && (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}
    </form>
  );
}

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
