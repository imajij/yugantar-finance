"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { ConfirmWithReason } from "@/components/confirm";

/**
 * Editing a vendor's details, and retiring one.
 *
 * Both already existed as rules and neither had a control, which meant a phone
 * number typed wrong stayed wrong and a vendor entered by mistake stayed on every
 * dropdown forever.
 *
 * Two things worth knowing about the shape of this. Bank fields are only editable
 * by whoever may see them in full — an HOD sees `••••4321` (20.7), and letting them
 * "correct" a masked value would write the mask into the record. And deleting is
 * soft and conditional: the API refuses while any request against the vendor is
 * still live, and says which ones, because a vendor is the counterparty on a
 * payment trail rather than a row in a list.
 */

const FIELD =
  "w-full rounded-[var(--r-control)] px-3.5 py-2.5 text-[13.5px] bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

export interface VendorFields {
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  upiId: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  notes: string | null;
}

const TEXT_FIELDS: { key: keyof VendorFields; label: string; bank?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "contactName", label: "Contact" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "gstin", label: "GSTIN" },
  { key: "upiId", label: "UPI ID", bank: true },
  { key: "bankAccountName", label: "Account name", bank: true },
  { key: "bankAccountNumber", label: "Account number", bank: true },
  { key: "bankIfsc", label: "IFSC", bank: true },
];

/** snake_case for the API, and only the fields this caller was allowed to touch. */
function payload(f: VendorFields, canEditBank: boolean) {
  const body: Record<string, string | null> = {
    name: f.name.trim(),
    contact_name: f.contactName?.trim() || null,
    phone: f.phone?.trim() || null,
    email: f.email?.trim() || null,
    gstin: f.gstin?.trim() || null,
    notes: f.notes?.trim() || null,
  };
  if (canEditBank) {
    body.upi_id = f.upiId?.trim() || null;
    body.bank_account_name = f.bankAccountName?.trim() || null;
    body.bank_account_number = f.bankAccountNumber?.trim() || null;
    body.bank_ifsc = f.bankIfsc?.trim() || null;
  }
  return body;
}

function errorFrom(body: unknown): string {
  const e = (body as {
    error?: { message?: string; details?: { requests?: { human_id: string; status: string }[] } };
  })?.error;
  if (!e) return "That did not work";
  const live = e.details?.requests;
  if (live?.length) {
    return `${e.message}: ${live.map((r) => `${r.human_id} (${r.status.toLowerCase()})`).join(", ")}. Settle or cancel those first.`;
  }
  return e.message ?? "That did not work";
}

export function VendorAdmin({
  vendor, canEdit, canEditBank, canDelete,
}: {
  vendor: VendorFields & { id: string };
  canEdit: boolean;
  /** Whoever may see account numbers in full — anyone else would save the mask. */
  canEditBank: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<VendorFields>(vendor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (!canEdit && !canDelete) return null;

  async function save() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/vendors/${vendor.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload(f, canEditBank)),
    });
    setBusy(false);
    if (!res.ok) { setError(errorFrom(await res.json().catch(() => null))); return; }
    setEditing(false);
    router.refresh();
  }

  async function remove(reason: string) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/vendors/${vendor.id}?reason=${encodeURIComponent(reason)}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!res.ok) { setError(errorFrom(await res.json().catch(() => null))); setConfirming(false); return; }
    router.push("/vendors");
    router.refresh();
  }

  if (editing) {
    return (
      <div
        className="mt-4 space-y-3 rounded-xl p-4"
        style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
      >
        <h2 className="font-display text-sm">Edit {vendor.name}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {TEXT_FIELDS.filter((t) => !t.bank || canEditBank).map((t) => (
            <label key={t.key} className="block">
              <span className="text-xs text-text-muted">{t.label}</span>
              <input
                value={(f[t.key] as string | null) ?? ""}
                onChange={(e) => setF({ ...f, [t.key]: e.target.value })}
                className={`${FIELD} mt-1`}
              />
            </label>
          ))}
        </div>

        <label className="block">
          <span className="text-xs text-text-muted">Notes</span>
          <textarea
            rows={2}
            value={f.notes ?? ""}
            onChange={(e) => setF({ ...f, notes: e.target.value })}
            className={`${FIELD} mt-1`}
          />
        </label>

        {!canEditBank && (
          <p className="text-[11px] text-text-muted">
            Bank and UPI details are masked for you, so they are not editable here — saving a
            masked number would overwrite the real one. Finance or Management can change them.
          </p>
        )}
        {error && <p className="text-[11px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

        <div className="flex gap-2.5">
          <Button tone="primary" disabled={busy || f.name.trim().length < 2} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </Button>
          <Button tone="ghost" onClick={() => { setEditing(false); setF(vendor); setError(null); }}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5">
      {canEdit && (
        <Button tone="ghost" onClick={() => setEditing(true)}>
          <Pencil size={16} aria-hidden /> Edit details
        </Button>
      )}
      {canDelete && (
        <Button
          tone="ghost"
          onClick={() => setConfirming(true)}
          style={{ border: "1px solid var(--flag-high-bg)", color: "var(--flag-high-fg)" }}
        >
          <Trash2 size={16} aria-hidden /> Retire vendor
        </Button>
      )}
      {error && !confirming && (
        <span className="text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</span>
      )}

      <ConfirmWithReason
        open={confirming}
        title={`Retire ${vendor.name}?`}
        consequence={
          <>They disappear from the vendor list and from new requests. Everything already raised
            against them keeps working and keeps naming them — nothing is erased. This is refused
            while any request against them is still live.</>
        }
        confirmLabel="Retire it"
        cancelLabel="Keep it"
        tone="destructive"
        reason={{ label: "Why they are being retired", placeholder: "Not using them again after the sound shortfall." }}
        busy={busy}
        error={error}
        onConfirm={remove}
        onCancel={() => { setConfirming(false); setError(null); }}
      />
    </div>
  );
}
