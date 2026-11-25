"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BanknoteArrowUp } from "lucide-react";
import { Button } from "@/components/ui";
import { Spinner } from "@/components/confirm";
import { FileUpload, type Uploaded } from "@/components/file-upload";
import { formatPaise, rupeesToPaise } from "@/lib/money";

/**
 * Recording a vendor payment, in full or in part (7.3).
 *
 * The first payment against a milestone is the advance or the balance, and the
 * person recording it says whether it paid the whole of it. If it did not, the
 * milestone stays owed for the rest, and this offers the remaining payment — with
 * its own reference, date and receipt — until it is paid off.
 */

export interface Payable {
  milestoneId: string;
  kind: string;
  action: "RECORD_ADVANCE" | "RECORD_BALANCE" | "RECORD_REMAINING";
  plannedPaise: number;
  paidPaise: number;
  owedPaise: number;
}

const FIELD =
  "w-full rounded-[var(--r-control)] px-3.5 py-2.5 text-[13.5px] bg-[var(--yg-surface)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

const today = () => new Date().toISOString().slice(0, 10);

const title = (p: Payable) =>
  p.action === "RECORD_REMAINING"
    ? `Record remaining ${p.kind.toLowerCase()} payment`
    : `Record ${p.kind.toLowerCase()} payment`;

function parsePaise(value: string): number | null {
  try {
    return rupeesToPaise(value);
  } catch {
    return null;
  }
}

export function RecordVendorPayment({
  requestId, vendorName, payables,
}: {
  requestId: string;
  vendorName: string;
  payables: Payable[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="mt-4 flex flex-col gap-3">
      {payables.map((p) =>
        open === p.milestoneId ? (
          <PaymentForm
            key={p.milestoneId}
            requestId={requestId}
            vendorName={vendorName}
            payable={p}
            onDone={() => setOpen(null)}
          />
        ) : (
          <div key={p.milestoneId} className="flex flex-wrap items-center gap-3">
            <Button tone={p.action === "RECORD_REMAINING" ? "primary" : "hero"} onClick={() => setOpen(p.milestoneId)}>
              <BanknoteArrowUp size={16} aria-hidden /> {title(p)}
            </Button>
            <span className="text-[12.5px] text-text-muted">
              {p.paidPaise > 0 ? (
                <>
                  <span className="tnum">{formatPaise(p.paidPaise)}</span> of{" "}
                  <span className="tnum">{formatPaise(p.plannedPaise)}</span> paid ·{" "}
                  <span className="tnum text-text">{formatPaise(p.owedPaise)}</span> left
                </>
              ) : (
                <><span className="tnum text-text">{formatPaise(p.owedPaise)}</span> due</>
              )}
            </span>
          </div>
        ),
      )}
    </div>
  );
}

function PaymentForm({
  requestId, vendorName, payable, onDone,
}: {
  requestId: string; vendorName: string; payable: Payable; onDone: () => void;
}) {
  const router = useRouter();
  const [full, setFull] = useState(true);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [receipt, setReceipt] = useState<Uploaded[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const partPaise = parsePaise(amount);
  const paying = full ? payable.owedPaise : partPaise;
  const partValid = partPaise !== null && partPaise > 0 && partPaise < payable.owedPaise;
  const ready = reference.trim().length >= 3 && Boolean(paidAt) && (full || partValid);
  const remainder = !full && partValid ? payable.owedPaise - partPaise! : null;

  async function submit() {
    if (!ready || paying === null) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/vendor-requests/${requestId}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        action: payable.action,
        milestone_id: payable.milestoneId,
        paid_paise: paying,
        paid_at: paidAt,
        payment_reference: reference.trim(),
        ...(receipt[0] ? { proof_attachment_id: receipt[0].id } : {}),
      }),
    });
    const json = await res.json().catch(() => null);
    setBusy(false);
    if (!res.ok) {
      setError(json?.error?.message ?? "That did not work");
      return;
    }
    onDone();
    router.refresh();
  }

  const choice = (on: boolean) =>
    on
      ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)" }
      : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" };

  return (
    <div
      className={`flex w-full flex-col gap-3.5 rounded-[var(--r-card)] p-4 ${busy ? "is-pending" : ""}`}
      style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
    >
      <p className="text-[13.5px]">
        {title(payable)} to <strong>{vendorName}</strong> ·{" "}
        <span className="tnum">{formatPaise(payable.owedPaise)}</span>{" "}
        {payable.paidPaise > 0 ? "left to pay" : "due"}
      </p>

      <fieldset className="flex flex-col gap-2">
        <legend className="meta-label mb-2">How much was paid</legend>
        <div className="flex flex-wrap gap-1.5 text-[13px]" role="radiogroup">
          <button
            type="button" role="radio" aria-checked={full}
            className="rounded-full px-3.5 py-2" style={choice(full)}
            onClick={() => setFull(true)}
          >
            Fully paid · <span className="tnum">{formatPaise(payable.owedPaise)}</span>
          </button>
          <button
            type="button" role="radio" aria-checked={!full}
            className="rounded-full px-3.5 py-2" style={choice(!full)}
            onClick={() => setFull(false)}
          >
            Partially paid
          </button>
        </div>
        {!full && (
          <label className="flex flex-col gap-1.5">
            <span className="meta-label">Amount paid now (₹)</span>
            <input
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className={`${FIELD} tnum`}
              aria-label="Amount paid now in rupees"
            />
            <span className="text-[12px] text-text-muted">
              {amount && !partValid
                ? `More than nothing and less than ${formatPaise(payable.owedPaise)} — paying all of it is "Fully paid".`
                : remainder !== null
                  ? <><span className="tnum">{formatPaise(remainder)}</span> will still be owed, and stays committed until the remaining payment is recorded.</>
                  : "The rest stays owed until you record the remaining payment."}
            </span>
          </label>
        )}
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="meta-label">Reference from the bank</span>
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            placeholder="UTR 447120"
            className={`${FIELD} tnum`}
            aria-label="Payment reference"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="meta-label">Date it left</span>
          <input
            type="date"
            value={paidAt}
            max={today()}
            onChange={(e) => setPaidAt(e.target.value)}
            className={`${FIELD} tnum`}
            aria-label="Date paid"
          />
        </label>
      </div>

      <FileUpload
        files={receipt}
        onChange={setReceipt}
        max={1}
        purpose="OTHER"
        label={payable.action === "RECORD_REMAINING" ? "Receipt for the remaining payment" : "Payment receipt"}
        hint="A screenshot of the transfer or the vendor's receipt. JPG, PNG, HEIC or PDF, up to 10 MB."
      />

      {error && <p className="text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <div className="flex flex-wrap gap-2.5">
        <Button tone="hero" disabled={busy || !ready} onClick={submit}>
          {busy && <Spinner />}
          {busy ? "Recording…" : `Record ${paying !== null && (full || partValid) ? formatPaise(paying) : "payment"}`}
        </Button>
        <Button tone="ghost" onClick={() => { onDone(); setError(null); }}>Cancel</Button>
      </div>
    </div>
  );
}
