"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Camera, Loader2, X } from "lucide-react";
import { formatPaise, rupeesToPaise } from "@/lib/money";

interface LineItemOption { id: string; name: string; availablePaise: number; defaultExpenseTypeId: string | null }
interface Props {
  lineItems: LineItemOption[];
  expenseTypes: { id: string; name: string }[];
  defaults: { payeeName: string; payeeUpiId: string };
  receiptWindow: { start: string; end: string };
}

interface Receipt { id: string; name: string }

const field = "mt-1 w-full rounded-lg px-3 py-2.5 text-sm";
const fieldStyle = { background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" };

export function NewRequestForm({ lineItems, expenseTypes, defaults, receiptWindow }: Props) {
  const router = useRouter();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineItemId, setLineItemId] = useState(lineItems[0]?.id ?? "");
  const [amount, setAmount] = useState("");

  const selected = lineItems.find((i) => i.id === lineItemId);
  const amountPaise = safePaise(amount);
  const overBudget = selected && amountPaise !== null && amountPaise > selected.availablePaise;

  /** 20.2 — presign, PUT the file, then complete so the server can hash it for F1. */
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files).slice(0, 5 - receipts.length)) {
        const presign = await postJson("/api/v1/attachments/presign", {
          purpose: "RECEIPT", file_name: file.name, mime_type: file.type, size_bytes: file.size,
        });
        const put = await fetch(presign.upload_url, { method: "PUT", body: file });
        if (!put.ok) throw new Error("Upload failed");
        await postJson(`/api/v1/attachments/${presign.attachment_id}/complete`, {});
        setReceipts((r) => [...r, { id: presign.attachment_id, name: file.name }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    // Which button was pressed — the native way, no duplicate handler.
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const andSubmit = submitter?.value !== "draft";
    setError(null);

    let paise: number;
    try {
      paise = rupeesToPaise(String(form.get("amount")));
    } catch {
      setError("Amount must be rupees, up to two decimals");
      return;
    }

    setSubmitting(true);
    try {
      const created = await postJson("/api/v1/reimbursements", {
        line_item_id: form.get("line_item_id"),
        expense_type_id: form.get("expense_type_id"),
        description: form.get("description"),
        transaction_on: form.get("transaction_on"),
        amount_paise: paise,
        merchant: String(form.get("merchant") || "") || null,
        payee_name: form.get("payee_name"),
        payee_upi_id: form.get("payee_upi_id"),
        attachment_ids: receipts.map((r) => r.id),
        submit: andSubmit,
      });
      router.push(`/requests/${created.id}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the request");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div>
        <label className="text-sm text-text-soft">
          Receipts <span style={{ color: "var(--yg-pink)" }}>*</span>
        </label>
        <p className="text-xs text-text-muted">JPG, PNG, HEIC or PDF, up to 10 MB each. Five at most.</p>

        <label
          className="mt-2 flex cursor-pointer items-center justify-center gap-2 rounded-lg border-dashed py-6 text-sm"
          style={{ border: "1px dashed var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          {uploading ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Camera size={16} aria-hidden />}
          {uploading ? "Uploading…" : "Take a photo or choose a file"}
          <input
            type="file" className="sr-only" multiple
            accept="image/jpeg,image/png,image/heic,image/webp,application/pdf"
            capture="environment"
            disabled={uploading || receipts.length >= 5}
            onChange={(e) => upload(e.target.files)}
          />
        </label>

        {receipts.length > 0 && (
          <ul className="mt-2 space-y-1">
            {receipts.map((r) => (
              <li key={r.id} className="flex items-center justify-between rounded-lg px-3 py-2 text-xs" style={{ background: "var(--yg-surface)" }}>
                <span className="truncate">{r.name}</span>
                <button
                  type="button" aria-label={`Remove ${r.name}`}
                  onClick={() => setReceipts((list) => list.filter((x) => x.id !== r.id))}
                  className="text-text-muted hover:text-text"
                >
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <label htmlFor="line_item_id" className="text-sm text-text-soft">Line item *</label>
        <select
          id="line_item_id" name="line_item_id" required className={field} style={fieldStyle}
          value={lineItemId} onChange={(e) => setLineItemId(e.target.value)}
        >
          {lineItems.length === 0 && <option value="">No open line items in your department</option>}
          {lineItems.map((i) => (
            <option key={i.id} value={i.id}>{i.name} — {formatPaise(i.availablePaise)} available</option>
          ))}
        </select>
        {overBudget && (
          <p className="mt-1 text-xs" style={{ color: "var(--flag-high-fg)" }}>
            This is more than the {formatPaise(selected!.availablePaise)} available. It will be flagged, not blocked —
            Finance will see why.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="expense_type_id" className="text-sm text-text-soft">Expense type *</label>
          <select
            id="expense_type_id" name="expense_type_id" required className={field} style={fieldStyle}
            defaultValue={selected?.defaultExpenseTypeId ?? ""}
          >
            {expenseTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="amount" className="text-sm text-text-soft">Amount (₹) *</label>
          <input
            id="amount" name="amount" required inputMode="decimal" placeholder="1250.00"
            className={`${field} tnum`} style={fieldStyle}
            value={amount} onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>

      <div>
        <label htmlFor="description" className="text-sm text-text-soft">What was it for? *</label>
        <textarea
          id="description" name="description" required minLength={10} rows={3}
          placeholder="Cables and adapters for the main stage sound check"
          className={field} style={fieldStyle}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="transaction_on" className="text-sm text-text-soft">Date on the receipt *</label>
          <input
            id="transaction_on" name="transaction_on" type="date" required
            className={`${field} tnum`} style={fieldStyle}
          />
          <p className="mt-1 text-xs text-text-muted">
            Fest window {receiptWindow.start} to {receiptWindow.end}. Outside it is flagged, not blocked.
          </p>
        </div>
        <div>
          <label htmlFor="merchant" className="text-sm text-text-soft">Merchant</label>
          <input id="merchant" name="merchant" className={field} style={fieldStyle} placeholder="Optional" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="payee_name" className="text-sm text-text-soft">Pay to *</label>
          <input id="payee_name" name="payee_name" required defaultValue={defaults.payeeName} className={field} style={fieldStyle} />
        </div>
        <div>
          <label htmlFor="payee_upi_id" className="text-sm text-text-soft">Payee UPI ID *</label>
          <input
            id="payee_upi_id" name="payee_upi_id" required defaultValue={defaults.payeeUpiId}
            placeholder="name@bank" className={`${field} tnum`} style={fieldStyle}
          />
        </div>
      </div>

      {error && (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}>
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit" disabled={submitting || receipts.length === 0}
          className="rounded-full px-5 py-2.5 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
        <button
          type="submit" value="draft" disabled={submitting || receipts.length === 0}
          className="rounded-full px-5 py-2.5 text-sm disabled:opacity-50"
          style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
        >
          Save as draft
        </button>
      </div>
    </form>
  );
}

function safePaise(value: string): number | null {
  try {
    return rupeesToPaise(value);
  } catch {
    return null;
  }
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? `Request failed (${res.status})`);
  return json;
}
