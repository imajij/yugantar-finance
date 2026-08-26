"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BanknoteArrowUp, Pause } from "lucide-react";
import { Button } from "@/components/ui";
import { ConfirmWithReason, Spinner } from "@/components/confirm";
import { FileUpload, type Uploaded } from "@/components/file-upload";
import { formatPaise } from "@/lib/money";

/**
 * Recording a payment from the queue, rather than opening each request to do it.
 *
 * PRD 9 asks for exactly this — "one-click record payment (reference, date,
 * screenshot)" — and it was the missing half of the payment flow. The transition
 * has always existed; what did not was any way to reach it without leaving the list
 * of things you are working through, which is how somebody pays eleven people from
 * their banking app in one sitting.
 *
 * It is the only place in the product that moves money out, so it asks for the two
 * facts that make a payout auditable: the reference the bank gave it, and the date
 * it left. A screenshot is optional and usually worth taking.
 */

const FIELD =
  "w-full rounded-[var(--r-control)] px-3.5 py-2.5 text-[13.5px] bg-[var(--yg-surface)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

const today = () => new Date().toISOString().slice(0, 10);

const message = (b: unknown) =>
  (b as { error?: { message?: string } })?.error?.message ?? "That did not work";

export function RecordPayment({
  id, humanId, payeeName, amountPaise, payeeUpiId,
}: {
  id: string;
  humanId: string;
  payeeName: string;
  amountPaise: number;
  payeeUpiId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [holding, setHolding] = useState(false);
  const [reference, setReference] = useState("");
  const [paidAt, setPaidAt] = useState(today());
  const [proof, setProof] = useState<Uploaded[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/reimbursements/${id}/transitions`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return false; }
    router.refresh();
    return true;
  }

  return (
    <div className={`flex flex-wrap items-center gap-2 ${busy ? "is-pending" : ""}`}>
      {!open ? (
        <>
          <Button tone="hero" onClick={() => setOpen(true)}>
            <BanknoteArrowUp size={16} aria-hidden /> Record payment
          </Button>
          <Button
            tone="ghost"
            onClick={() => setHolding(true)}
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-muted)" }}
          >
            <Pause size={15} aria-hidden /> Hold
          </Button>
          {error && (
            <span className="basis-full text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</span>
          )}
        </>
      ) : (
        <div
          className="flex w-full flex-col gap-3 rounded-[var(--r-card)] p-4"
          style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
        >
          <p className="text-[13.5px]">
            Paying <strong>{payeeName}</strong>{" "}
            <span className="tnum">{formatPaise(amountPaise)}</span>
            {payeeUpiId && <span className="tnum text-text-muted"> · {payeeUpiId}</span>}
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="meta-label">Reference from the bank</span>
              <input
                autoFocus
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR 447120"
                className={`${FIELD} tnum`}
                aria-label={`Payment reference for ${humanId}`}
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
                aria-label={`Date paid for ${humanId}`}
              />
            </label>
          </div>

          <FileUpload
            files={proof}
            onChange={setProof}
            max={1}
            purpose="OTHER"
            label="Screenshot of the transfer"
            hint="Optional, and worth taking — it is what settles a question about this payout months later."
          />

          {error && <p className="text-[12px]" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

          <div className="flex flex-wrap gap-2.5">
            <Button
              tone="hero"
              disabled={busy || reference.trim().length < 3 || !paidAt}
              onClick={async () => {
                const ok = await post({
                  action: "RECORD_PAYMENT",
                  payment_reference: reference.trim(),
                  paid_at: paidAt,
                  ...(proof[0] ? { proof_attachment_id: proof[0].id } : {}),
                });
                if (ok) { setOpen(false); setReference(""); setProof([]); }
              }}
            >
              {busy && <Spinner />}
              {busy ? "Recording…" : `Mark ${humanId} paid`}
            </Button>
            <Button tone="ghost" onClick={() => { setOpen(false); setError(null); }}>Cancel</Button>
          </div>
        </div>
      )}

      <ConfirmWithReason
        open={holding}
        title={`Hold ${humanId}?`}
        consequence={
          <>Payment stops until Finance resolves it. The amount stays counted as committed against
            the department, so it is not released back &mdash; and {payeeName} is told it is on hold.</>
        }
        confirmLabel="Put it on hold"
        cancelLabel="Leave it in the queue"
        tone="destructive"
        reason={{ label: "Why", placeholder: "Bank details do not match the name on the receipt." }}
        busy={busy}
        error={error}
        onConfirm={async (reason) => {
          if (await post({ action: "HOLD", reason })) setHolding(false);
        }}
        onCancel={() => { setHolding(false); setError(null); }}
      />
    </div>
  );
}
