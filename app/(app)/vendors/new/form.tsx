"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Required } from "@/components/ui";

const INPUT = "mt-1 w-full rounded-lg px-3 py-2.5 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

export function VendorForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const body = Object.fromEntries(
      [...f.entries()].map(([k, v]) => [k, String(v).trim() || null]),
    );

    const res = await fetch("/api/v1/vendors", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "Could not save that vendor");
      return;
    }
    router.push(`/vendors/${json.id}`);
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label="Vendor name" required><input name="name" required minLength={2} maxLength={120} className={INPUT} /></Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact person"><input name="contact_name" maxLength={120} className={INPUT} /></Field>
        <Field label="Phone"><input name="phone" type="tel" maxLength={20} className={INPUT} /></Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email"><input name="email" type="email" className={INPUT} /></Field>
        <Field label="GSTIN"><input name="gstin" maxLength={20} className={INPUT} /></Field>
      </div>

      <Field label="UPI ID" hint="Either UPI or bank details — whichever they take payment on.">
        <input name="upi_id" maxLength={80} className={INPUT} />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Account name"><input name="bank_account_name" maxLength={120} className={INPUT} /></Field>
        <Field label="Account number"><input name="bank_account_number" maxLength={30} className={INPUT} /></Field>
      </div>
      <Field label="IFSC"><input name="bank_ifsc" maxLength={15} className={INPUT} /></Field>

      <Field label="Notes"><textarea name="notes" rows={3} maxLength={1000} className={INPUT} /></Field>

      <button type="submit" disabled={busy}
        className="rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-50"
        style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}>
        {busy ? "Saving…" : "Save vendor"}
      </button>

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
