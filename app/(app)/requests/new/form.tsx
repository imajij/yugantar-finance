"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ArrowLeft, Camera, ChevronDown, FileCheck, Loader2, Plus, Receipt as ReceiptIcon, Send, X,
} from "lucide-react";
import { formatPaise, rupeesToPaise } from "@/lib/money";
import { Button, IconButton, Required } from "@/components/ui";
import { ErrorNote, InfoNote } from "@/components/feedback";
import { AvailableInline } from "@/components/five-numbers";

/**
 * Submitting a receipt, in three steps instead of eleven stacked inputs.
 *
 * This is the screen the redesign exists for. It is used by a Member standing
 * outside a venue at 11pm, one-handed, in a hurry, and it was a desktop form: a
 * vertical column of labelled fields where the camera was the fourth thing you
 * reached and the amount was somewhere below the fold.
 *
 * The order is now the order of the task. **Photograph it** — the camera is the
 * first and largest thing on the screen. **Say how much and against what** — the
 * only two fields that need thought, with the line item showing what will be left
 * afterwards so nobody discovers an overspend at approval time. **Check and
 * submit** — everything else pre-filled from who you are and correctable in place.
 *
 * Nothing is hidden that the API needs; the fields that used to be typed are now
 * defaulted, shown, and one tap from being changed.
 */

interface LineItemOption {
  id: string;
  name: string;
  availablePaise: number;
  plannedPaise: number;
  pendingPaise: number;
  committedPaise: number;
  spentPaise: number;
  defaultExpenseTypeId: string | null;
}

interface Props {
  lineItems: LineItemOption[];
  expenseTypes: { id: string; name: string }[];
  defaults: { payeeName: string; payeeUpiId: string; department: string };
  receiptWindow: { start: string; end: string };
  /**
   * Whether this person may see what is in the pot they are charging.
   *
   * A Member may not (5.1), so for them the line item is a choice by name and the
   * page carries no balance, no bar and no "what will be left" — those are the
   * head's business. Passed in rather than inferred, because the server has already
   * decided it and the amounts were never fetched.
   */
  showsBudget: boolean;
}

interface Receipt { id: string; name: string }

const ACCEPT = "image/jpeg,image/png,image/heic,image/webp,application/pdf";
const MAX_RECEIPTS = 5;
const MAX_PROOFS = 3;

const FIELD =
  "w-full rounded-[var(--r-control)] px-4 py-3 text-[14px] bg-[var(--yg-surface)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)] outline-none";

const today = () => new Date().toISOString().slice(0, 10);

export function NewRequestForm({
  lineItems, expenseTypes, defaults, receiptWindow, showsBudget,
}: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [uploading, setUploading] = useState(false);
  const [proofs, setProofs] = useState<Receipt[]>([]);
  const [uploadingProof, setUploadingProof] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lineItemId, setLineItemId] = useState(lineItems[0]?.id ?? "");
  const [pickingLineItem, setPickingLineItem] = useState(false);
  const [amount, setAmount] = useState("");
  const [expenseTypeId, setExpenseTypeId] = useState("");
  const [description, setDescription] = useState("");
  const [transactionOn, setTransactionOn] = useState(today());
  const [merchant, setMerchant] = useState("");
  const [payeeName, setPayeeName] = useState(defaults.payeeName);
  const [payeeUpiId, setPayeeUpiId] = useState(defaults.payeeUpiId);

  const selected = lineItems.find((i) => i.id === lineItemId);
  const amountPaise = safePaise(amount);
  const chosenType = expenseTypeId || selected?.defaultExpenseTypeId || expenseTypes[0]?.id || "";
  const remaining = selected && amountPaise !== null ? selected.availablePaise - amountPaise : null;
  const outsideWindow = transactionOn < receiptWindow.start || transactionOn > receiptWindow.end;

  if (lineItems.length === 0) {
    return (
      <ErrorNote detail="Ask your HOD to break the department's allocation into line items — a claim has to be charged against one.">
        Your department has no open line items, so there is nowhere to file this claim.
      </ErrorNote>
    );
  }

  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError(null);
    try {
      await uploadAll(files, "RECEIPT", MAX_RECEIPTS - receipts.length, (r) => setReceipts((all) => [...all, r]));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function uploadProof(files: FileList | null) {
    if (!files?.length) return;
    setUploadingProof(true);
    setError(null);
    try {
      await uploadAll(files, "CLAIM_PAYMENT_PROOF", MAX_PROOFS - proofs.length, (r) => setProofs((all) => [...all, r]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploadingProof(false);
    }
  }

  async function save(andSubmit: boolean) {
    setError(null);
    if (amountPaise === null || amountPaise <= 0) {
      setError("Enter the amount in rupees, like 8400 or 8400.50");
      setStep(2);
      return;
    }

    setSubmitting(true);
    try {
      const created = await postJson("/api/v1/reimbursements", {
        line_item_id: lineItemId,
        expense_type_id: chosenType,
        description,
        transaction_on: transactionOn,
        amount_paise: amountPaise,
        merchant: merchant.trim() || null,
        payee_name: payeeName,
        payee_upi_id: payeeUpiId,
        attachment_ids: receipts.map((r) => r.id),
        payment_proof_ids: proofs.map((p) => p.id),
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
    <div className="flex w-full max-w-[430px] flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        {step === 1 ? (
          <IconButton label="Leave without saving" onClick={() => router.push("/requests")}>
            <X size={18} aria-hidden />
          </IconButton>
        ) : (
          <IconButton label="Back a step" onClick={() => setStep(step - 1)}>
            <ArrowLeft size={18} aria-hidden />
          </IconButton>
        )}
        <span className="font-display text-[15px]">
          {step === 3 ? "Check and submit" : "New reimbursement"}
        </span>
        <span className="tnum w-11 text-right text-[12px] text-text-muted">{step}/3</span>
      </header>

      <div className="flex gap-1.5" aria-hidden>
        {[1, 2, 3].map((n) => (
          <span
            key={n}
            className="h-1 flex-1 rounded-full"
            style={{ background: n <= step ? "var(--yg-accent)" : "var(--yg-surface-2)" }}
          />
        ))}
      </div>

      {error && <ErrorNote>{error}</ErrorNote>}

      {/* ───────────────────────────────────────────────── 1 · photograph it */}
      {step === 1 && (
        <>
          <h2 className="font-display text-[24px] leading-tight">Photograph the receipt</h2>
          <p className="text-[13px] leading-relaxed text-text-muted">
            Get the total and the shop name in frame. You can add more pages after.
          </p>

          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-3.5 rounded-[20px] py-14"
            style={{ background: "var(--yg-surface)", border: "1px dashed var(--yg-outline)" }}
          >
            <span
              className="flex size-[76px] items-center justify-center rounded-full"
              style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
            >
              {uploading ? <Loader2 size={32} className="yg-spin" aria-hidden /> : <Camera size={32} aria-hidden />}
            </span>
            <span className="text-[14px] font-medium">{uploading ? "Uploading…" : "Open camera"}</span>
            <span className="text-[12px] text-text-muted">or choose from photos</span>
            <input
              type="file"
              className="sr-only"
              multiple
              capture="environment"
              accept={ACCEPT}
              onChange={(e) => upload(e.target.files)}
              disabled={uploading || receipts.length >= MAX_RECEIPTS}
            />
          </label>

          {receipts.length > 0 && <ReceiptList receipts={receipts} onAdd={upload} uploading={uploading} />}

          <p className="text-[12px] leading-relaxed text-text-muted">
            JPG, PNG, HEIC or PDF, up to 10&nbsp;MB each, five at most. A claim needs at
            least one before it can be saved or submitted.
          </p>

          <Button tone="ghost" onClick={() => setStep(2)} className="w-full">
            {receipts.length > 0 ? "Next" : "Skip for now"}
          </Button>
        </>
      )}

      {/* ────────────────────────────────────── 2 · how much, and against what */}
      {step === 2 && (
        <>
          {receipts.length > 0 && <ReceiptList receipts={receipts} onAdd={upload} uploading={uploading} />}

          <section className="flex flex-col gap-2">
            <label htmlFor="amount" className="meta-label">Amount you paid <Required /></label>
            <div
              className="flex items-baseline gap-2 rounded-[18px] px-4 py-3.5"
              style={{
                background: "var(--yg-surface)",
                border: `1px solid ${amountPaise && amountPaise > 0 ? "var(--yg-accent)" : "var(--yg-surface-2)"}`,
              }}
            >
              <span className="tnum text-[26px] text-text-muted">₹</span>
              <input
                id="amount"
                inputMode="decimal"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="tnum w-full bg-transparent text-[34px] font-semibold outline-none"
                aria-label="Amount in rupees"
                aria-required="true"
              />
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <span className="meta-label">Against which line item <Required announce /></span>
            <div
              className="flex flex-col gap-2.5 rounded-[var(--r-card)] px-4 py-3.5"
              style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
            >
              <button
                type="button"
                onClick={() => setPickingLineItem((v) => !v)}
                className="flex items-center justify-between gap-3 text-left"
              >
                <span className="text-[14px] font-medium">{selected?.name ?? "Choose one"}</span>
                <span className="flex items-center gap-1.5 text-[12px]" style={{ color: "var(--yg-info)" }}>
                  Change <ChevronDown size={14} aria-hidden />
                </span>
              </button>

              {selected && !pickingLineItem && showsBudget && (
                <>
                  <AvailableInline totals={{ ...selected, allocatedPaise: selected.plannedPaise }} />
                  <p className="text-[12px] text-text-soft">
                    <span className="tnum" style={{ color: remaining !== null && remaining < 0 ? "var(--flag-high-fg)" : "var(--yg-accent)" }}>
                      {formatPaise(remaining ?? selected.availablePaise)}
                    </span>{" "}
                    {remaining !== null && remaining < 0 ? "over this line item after the claim" : "available after this claim"}
                  </p>
                </>
              )}

              {pickingLineItem && (
                <ul className="flex flex-col gap-1">
                  {lineItems.map((i) => (
                    <li key={i.id}>
                      <button
                        type="button"
                        onClick={() => { setLineItemId(i.id); setPickingLineItem(false); }}
                        className="flex w-full items-center justify-between gap-3 rounded-[12px] px-3 py-2.5 text-left hover:bg-surface-2"
                      >
                        <span className="text-[13.5px]">{i.name}</span>
                        {showsBudget && (
                          <span className="tnum text-[12.5px] text-text-muted">{formatPaise(i.availablePaise)}</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <span className="meta-label">Expense type</span>
            <div className="flex flex-wrap gap-2">
              {expenseTypes.map((t) => {
                const on = chosenType === t.id;
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setExpenseTypeId(t.id)}
                    className="flex h-[var(--row-h)] items-center rounded-full px-4 text-[13px]"
                    style={
                      on
                        ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)" }
                        : { border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }
                    }
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </section>

          <Button
            tone="primary"
            className="w-full"
            disabled={!amountPaise || amountPaise <= 0 || !lineItemId}
            onClick={() => setStep(3)}
          >
            Next
          </Button>
        </>
      )}

      {/* ────────────────────────────────────────────── 3 · check and submit */}
      {step === 3 && (
        <>
          {/*
            Proof the money left the claimant's account, separate from the receipt:
            a receipt says what was bought, this says who paid for it. Required —
            the server refuses a claim without one.
          */}
          <section className="flex flex-col gap-2">
            <span className="meta-label">Proof of payment <Required announce /></span>
            {proofs.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {proofs.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2.5 rounded-[var(--r-control)] px-3 py-2.5 text-[12.5px]"
                    style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
                  >
                    <FileCheck size={16} aria-hidden style={{ color: "var(--state-done-fg)" }} />
                    <span className="min-w-0 flex-1 truncate">{p.name}</span>
                    <button
                      type="button"
                      className="tap text-text-muted"
                      onClick={() => setProofs((all) => all.filter((x) => x.id !== p.id))}
                      disabled={submitting}
                    >
                      <X size={15} aria-hidden />
                      <span className="sr-only">Remove {p.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {proofs.length < MAX_PROOFS && (
              <label
                className="flex cursor-pointer items-center justify-center gap-2 rounded-[var(--r-control)] py-3.5 text-[13px] font-medium"
                style={{
                  background: "var(--yg-surface)",
                  border: `1px dashed ${proofs.length === 0 ? "var(--yg-accent)" : "var(--yg-outline)"}`,
                  color: "var(--yg-accent)",
                }}
              >
                {uploadingProof ? <Loader2 size={16} className="yg-spin" aria-hidden /> : <Plus size={16} aria-hidden />}
                {uploadingProof ? "Uploading…" : proofs.length === 0 ? "Upload payment proof" : "Add another"}
                <input
                  type="file"
                  className="sr-only"
                  multiple
                  accept={ACCEPT}
                  onChange={(e) => { uploadProof(e.target.files); e.target.value = ""; }}
                  disabled={uploadingProof || submitting}
                  aria-required="true"
                />
              </label>
            )}
            <p className="text-[11.5px] text-text-muted">
              A UPI screenshot, card slip or bank statement line showing you paid. Image or
              PDF, up to 10&nbsp;MB, three at most.
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <label htmlFor="description" className="meta-label">What was it for</label>
            <textarea
              id="description"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Two truss sections hired from Shree Traders for the main stage on Wednesday."
              className={`${FIELD} min-h-[80px] leading-relaxed`}
            />
            <p className="text-[11.5px] text-text-muted">
              At least ten characters. Your HOD reads this before anything else.
            </p>
          </section>

          <div
            className="flex flex-col rounded-[var(--r-card)] px-4"
            style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
          >
            <Prefilled label="Amount" value={formatPaise(amountPaise ?? 0)} mono />
            <Prefilled label="Line item" value={selected?.name ?? "—"} />
            <Prefilled label="Department" value={defaults.department} />
            <Row label="Date on receipt" required>
              <input
                type="date"
                value={transactionOn}
                min={receiptWindow.start}
                max={receiptWindow.end}
                onChange={(e) => setTransactionOn(e.target.value)}
                className="tnum bg-transparent text-right text-[13px] outline-none"
                aria-label="Date on receipt"
              />
            </Row>
            <Row label="Shop or merchant">
              <input
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="optional"
                className="bg-transparent text-right text-[13px] outline-none"
                aria-label="Merchant"
              />
            </Row>
            <Row label="Paid by" required>
              <input
                value={payeeName}
                onChange={(e) => setPayeeName(e.target.value)}
                className="bg-transparent text-right text-[13px] outline-none"
                aria-label="Payee name"
              />
            </Row>
            <Row label="Pay back to" required last>
              <input
                value={payeeUpiId}
                onChange={(e) => setPayeeUpiId(e.target.value)}
                placeholder="you@upi"
                className="tnum bg-transparent text-right text-[13px] outline-none"
                aria-label="Payee UPI ID"
              />
            </Row>
          </div>

          {outsideWindow && (
            <InfoNote detail={`The fest's receipt window is ${receiptWindow.start} to ${receiptWindow.end}.`}>
              That date is outside the receipt window. It will be flagged, not blocked.
            </InfoNote>
          )}

          {/*
            The consequence, before the action: an HOD who does not know Pending is
            deducted will otherwise watch their Available drop and wonder who spent it.
          */}
          {selected && amountPaise !== null && (
            showsBudget ? (
              <InfoNote>
                <span className="tnum">{formatPaise(amountPaise)}</span> shows as{" "}
                <strong>pending</strong> against {defaults.department} until it is endorsed —{" "}
                {selected.name} drops to <span className="tnum">{formatPaise(selected.availablePaise - amountPaise)}</span>{" "}
                available in the meantime.
              </InfoNote>
            ) : (
              <InfoNote>
                This goes to {defaults.department}&rsquo;s head to endorse, then to Finance to
                approve. You will be told at each step.
              </InfoNote>
            )
          )}

          <div
            className="mt-1 flex flex-col gap-2.5 pt-4"
            style={{ borderTop: "1px solid var(--yg-surface-2)" }}
          >
            <Button
              tone="hero"
              className="h-[52px] w-full text-[15px]"
              disabled={
                submitting || uploadingProof || receipts.length === 0 || proofs.length === 0
                || description.trim().length < 10
              }
              onClick={() => save(true)}
            >
              {submitting ? <Loader2 size={17} className="yg-spin" aria-hidden /> : <Send size={17} aria-hidden />}
              Submit for endorsement
            </Button>
            <Button
              tone="ghost"
              className="w-full"
              disabled={submitting || uploadingProof || receipts.length === 0 || proofs.length === 0}
              onClick={() => save(false)}
            >
              Save as draft
            </Button>
            {(receipts.length === 0 || proofs.length === 0) && (
              <p className="text-center text-[11.5px] text-text-muted">
                {receipts.length === 0 && proofs.length === 0
                  ? "Add a receipt and proof of payment to save or submit this claim."
                  : receipts.length === 0
                    ? "Add at least one receipt to save or submit this claim."
                    : "Add proof of payment to save or submit this claim."}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function ReceiptList({
  receipts, onAdd, uploading,
}: {
  receipts: Receipt[]; onAdd: (f: FileList | null) => void; uploading: boolean;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-[var(--r-card)] p-3"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      <span
        className="flex h-[68px] w-14 shrink-0 items-center justify-center rounded-xl text-text-muted"
        style={{ background: "var(--yg-surface-2)" }}
        aria-hidden
      >
        <ReceiptIcon size={22} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[12.5px]">{receipts[0].name}</span>
        <span className="text-[11.5px]" style={{ color: "var(--state-done-fg)" }}>
          Uploaded{receipts.length > 1 ? ` · ${receipts.length} pages` : ""}
        </span>
      </span>
      <label className="tap cursor-pointer" style={{ color: "var(--yg-accent)" }}>
        <Plus size={18} aria-hidden />
        <span className="sr-only">Add another page</span>
        <input
          type="file"
          className="sr-only"
          multiple
          capture="environment"
          accept={ACCEPT}
          onChange={(e) => onAdd(e.target.files)}
          disabled={uploading || receipts.length >= MAX_RECEIPTS}
        />
      </label>
    </div>
  );
}

function Row({
  label, children, last, required,
}: { label: string; children: React.ReactNode; last?: boolean; required?: boolean }) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-3"
      style={last ? undefined : { borderBottom: "1px solid var(--yg-surface-2)" }}
    >
      <span className="flex shrink-0 items-baseline gap-1.5 text-[12.5px] text-text-muted">
        {label}
        {required && <Required />}
      </span>
      {children}
    </div>
  );
}

function Prefilled({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Row label={label}>
      <span className={`text-[13px] ${mono ? "tnum" : ""}`}>{value}</span>
    </Row>
  );
}

/** 20.2 — presign, PUT the file, then complete so the server can hash it for F1. */
async function uploadAll(
  files: FileList, purpose: "RECEIPT" | "CLAIM_PAYMENT_PROOF", room: number, onDone: (r: Receipt) => void,
) {
  for (const file of Array.from(files).slice(0, Math.max(0, room))) {
    const presign = await postJson("/api/v1/attachments/presign", {
      purpose, file_name: file.name, mime_type: file.type, size_bytes: file.size,
    });
    const put = await fetch(presign.upload_url, { method: "PUT", body: file });
    if (!put.ok) throw new Error("That upload did not go through. Try again when the signal is better.");
    await postJson(`/api/v1/attachments/${presign.attachment_id}/complete`, {});
    onDone({ id: presign.attachment_id, name: file.name });
  }
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
