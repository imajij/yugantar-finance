/**
 * The deterministic flag rules (PRD 8.2). F7, F10 and F11 need the model or a
 * population statistic and ship after these (8.2, v1.1 in 21.2).
 *
 * Flags are advisory: nothing here blocks anything (8.3).
 */
import { formatPaise } from "@/lib/money";
import type { FlagResult, Thresholds } from "./types";

export interface ReimbursementFacts {
  amountPaise: number;
  transactionOn: string;
  merchant: string | null;
  payeeUpiId: string;
  /** Receipt OCR output, when it has run (8.1). */
  ocrTotalPaise: number | null;
  ocrHasTotal: boolean;
  ocrHasDate: boolean;
  ocrRan: boolean;
  /** Another live request in this fest with the same receipt hash, or same amount+date+merchant. */
  duplicateOf: string | null;
  duplicateReason: "hash" | "details" | null;
  /** Available on the line item and the department *before* this request is counted. */
  lineItemAvailablePaise: number;
  departmentAvailablePaise: number;
  /** Other requests in this fest sharing the payee UPI ID (this one excluded). */
  payeeRequestCount: number;
  payeeTotalPaise: number;
  receiptWindowStart: string;
  receiptWindowEnd: string;
}

export function F1_duplicateReceipt(f: ReimbursementFacts): FlagResult | null {
  if (!f.duplicateOf) return null;
  return {
    rule: "F1", severity: "HIGH",
    explanation: f.duplicateReason === "hash"
      ? `This receipt file has already been submitted on ${f.duplicateOf}.`
      : `${formatPaise(f.amountPaise)} on ${f.transactionOn}${f.merchant ? ` at ${f.merchant}` : ""} was already submitted on ${f.duplicateOf}.`,
  };
}

export function F2_amountMismatch(f: ReimbursementFacts, t: Thresholds): FlagResult | null {
  if (f.ocrTotalPaise === null) return null;
  const diff = Math.abs(f.ocrTotalPaise - f.amountPaise);
  const pct = f.ocrTotalPaise === 0 ? 100 : (diff / f.ocrTotalPaise) * 100;
  if (diff <= t.F2_abs_paise && pct <= t.F2_pct) return null;
  return {
    rule: "F2", severity: "HIGH",
    explanation: `Receipt total reads ${formatPaise(f.ocrTotalPaise)} but ${formatPaise(f.amountPaise)} was entered.`,
  };
}

export function F3_unreadableReceipt(f: ReimbursementFacts): FlagResult | null {
  if (!f.ocrRan) return null;                       // OCR is v1.1; silent until it runs
  if (f.ocrHasTotal && f.ocrHasDate) return null;
  const missing = [!f.ocrHasTotal && "a total", !f.ocrHasDate && "a date"].filter(Boolean).join(" or ");
  return { rule: "F3", severity: "MEDIUM", explanation: `The receipt could not be read — no ${missing} was found.` };
}

export function F4_dateOutsideWindow(f: ReimbursementFacts): FlagResult | null {
  if (f.transactionOn >= f.receiptWindowStart && f.transactionOn <= f.receiptWindowEnd) return null;
  return {
    rule: "F4", severity: "MEDIUM",
    explanation: `Transaction date ${f.transactionOn} is outside the fest receipt window (${f.receiptWindowStart} to ${f.receiptWindowEnd}).`,
  };
}

export function F5_overBudget(f: ReimbursementFacts): FlagResult | null {
  // Approval would take Available below zero — at line-item or department level (8.2).
  const lineOver = f.amountPaise > f.lineItemAvailablePaise;
  const deptOver = f.amountPaise > f.departmentAvailablePaise;
  if (!lineOver && !deptOver) return null;
  const where = lineOver && deptOver ? "line item and the department"
    : lineOver ? "line item" : "department";
  const available = lineOver ? f.lineItemAvailablePaise : f.departmentAvailablePaise;
  return {
    rule: "F5", severity: "HIGH",
    explanation: `Approving ${formatPaise(f.amountPaise)} takes the ${where} below zero — ${formatPaise(available)} available.`,
  };
}

export function F6_repeatedPayee(f: ReimbursementFacts, t: Thresholds): FlagResult | null {
  const count = f.payeeRequestCount + 1;
  const total = f.payeeTotalPaise + f.amountPaise;
  if (count <= t.F6_count && total <= t.F6_total_paise) return null;
  return {
    rule: "F6", severity: "MEDIUM",
    explanation: `${f.payeeUpiId} is the payee on ${count} requests totalling ${formatPaise(total)} this fest.`,
  };
}

export const REIMBURSEMENT_RULES = [
  F1_duplicateReceipt,
  (f: ReimbursementFacts, t: Thresholds) => F2_amountMismatch(f, t),
  (f: ReimbursementFacts) => F3_unreadableReceipt(f),
  (f: ReimbursementFacts) => F4_dateOutsideWindow(f),
  (f: ReimbursementFacts) => F5_overBudget(f),
  (f: ReimbursementFacts, t: Thresholds) => F6_repeatedPayee(f, t),
] as const;

/* ------------------------------------------------------------------ line items */

export interface LineItemFacts {
  plannedPaise: number;
  documentCount: number;
  lowestQuotePaise: number | null;
  docThresholdPaise: number;
}

export function F13_missingSupport(f: LineItemFacts): FlagResult | null {
  if (f.docThresholdPaise <= 0) return null;
  if (f.plannedPaise < f.docThresholdPaise || f.documentCount > 0) return null;
  return {
    rule: "F13", severity: "MEDIUM",
    explanation: `Planned at ${formatPaise(f.plannedPaise)}, at or above the ${formatPaise(f.docThresholdPaise)} threshold, with no quotation or listing attached.`,
  };
}

export function F14_aboveQuote(f: LineItemFacts, t: Thresholds): FlagResult | null {
  if (f.lowestQuotePaise === null || f.lowestQuotePaise <= 0) return null;
  const overPct = ((f.plannedPaise - f.lowestQuotePaise) / f.lowestQuotePaise) * 100;
  if (overPct <= t.F14_pct) return null;
  return {
    rule: "F14", severity: "LOW",
    explanation: `Planned ${formatPaise(f.plannedPaise)} is ${overPct.toFixed(0)}% above the lowest quote of ${formatPaise(f.lowestQuotePaise)}.`,
  };
}

/* --------------------------------------------------------------- vendor requests */

export interface VendorFacts {
  totalValuePaise: number;
  advancePaise: number;
  approvedValuePaise: number | null;
  invoiceTotalPaise: number | null;
  expectedDeliveryOn: string | null;
  deliveredAt: Date | null;
  today: string;
}

export function F8_largeAdvance(f: VendorFacts, t: Thresholds): FlagResult | null {
  if (f.totalValuePaise <= 0) return null;
  const pct = (f.advancePaise / f.totalValuePaise) * 100;
  if (pct <= t.F8_pct) return null;
  return {
    rule: "F8", severity: "MEDIUM",
    explanation: `Advance of ${formatPaise(f.advancePaise)} is ${pct.toFixed(0)}% of the ${formatPaise(f.totalValuePaise)} contract.`,
  };
}

export function F9_invoiceMismatch(f: VendorFacts): FlagResult | null {
  const approved = f.approvedValuePaise ?? f.totalValuePaise;
  if (f.invoiceTotalPaise === null || f.invoiceTotalPaise === approved) return null;
  return {
    rule: "F9", severity: "HIGH",
    explanation: `Invoice total ${formatPaise(f.invoiceTotalPaise)} differs from the approved value ${formatPaise(approved)}.`,
  };
}

export function F12_deliveryOverdue(f: VendorFacts): FlagResult | null {
  if (!f.expectedDeliveryOn || f.deliveredAt) return null;
  if (f.expectedDeliveryOn >= f.today) return null;
  return {
    rule: "F12", severity: "MEDIUM",
    explanation: `Expected delivery was ${f.expectedDeliveryOn} and has not been confirmed.`,
  };
}
