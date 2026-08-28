/** PRD 7.3 / 20.7 — the vendor payment state machine. */
import type { Transition } from "./types";
import { assertTransition } from "./types";

export const VENDOR_STATES = [
  "DRAFT", "SUBMITTED", "SENT_BACK", "APPROVED", "ADVANCE_PAID", "DELIVERED", "BALANCE_APPROVED", "CLOSED", "DECLINED", "CANCELLED",
] as const;
export type VendorState = (typeof VENDOR_STATES)[number];

export const VENDOR_TERMINAL: readonly VendorState[] = ["CLOSED", "DECLINED", "CANCELLED"];

export const VENDOR_ACTIONS = [
  "SUBMIT", "APPROVE", "SEND_BACK", "DECLINE", "RESUBMIT", "RECORD_ADVANCE", "CONFIRM_DELIVERY",
  "RELEASE_BALANCE", "RECORD_BALANCE", "CLOSE", "CANCEL", "RECORD_REFUND",
] as const;
export type VendorAction = (typeof VENDOR_ACTIONS)[number];

type T = Transition<VendorState, VendorAction>;

export const VENDOR_TRANSITIONS: readonly T[] = [
  { from: "DRAFT", action: "SUBMIT", to: "SUBMITTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["SUBMITTER"] },

  { from: "SUBMITTED", action: "APPROVE", to: "APPROVED", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"] },
  { from: "SUBMITTED", action: "SEND_BACK", to: "SENT_BACK", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },
  { from: "SUBMITTED", action: "DECLINE", to: "DECLINED", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },

  { from: "SENT_BACK", action: "RESUBMIT", to: "SUBMITTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["SUBMITTER"] },

  { from: "APPROVED", action: "RECORD_ADVANCE", to: "ADVANCE_PAID", roles: ["MANAGEMENT"], requires: ["milestone_id", "paid_paise", "paid_at", "payment_reference"] },
  // Advance = 0 skips ADVANCE_PAID; the service checks the advance milestone is zero.
  { from: "APPROVED", action: "CONFIRM_DELIVERY", to: "DELIVERED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["delivered_at", "invoice_attachment_id"] },
  { from: "ADVANCE_PAID", action: "CONFIRM_DELIVERY", to: "DELIVERED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["delivered_at", "invoice_attachment_id"] },

  { from: "APPROVED", action: "CANCEL", to: "CANCELLED", roles: ["FINANCE_HOD"], requires: ["reason"] },
  { from: "ADVANCE_PAID", action: "CANCEL", to: "CANCELLED", roles: ["FINANCE_HOD"], requires: ["reason"] },

  { from: "DELIVERED", action: "RELEASE_BALANCE", to: "BALANCE_APPROVED", roles: ["FINANCE_HOD"] },
  // Balance = 0 closes straight from DELIVERED; the service checks the balance milestone is zero.
  { from: "DELIVERED", action: "CLOSE", to: "CLOSED", roles: ["FINANCE_HOD"] },

  // CLOSED is the usual landing, and only when nothing is left owing: a request with
  // a third milestone still unpaid stays here until that one is paid too, because
  // CLOSED drops it out of Committed entirely.
  { from: "BALANCE_APPROVED", action: "RECORD_BALANCE", to: "CLOSED", roles: ["MANAGEMENT"], requires: ["milestone_id", "paid_paise", "paid_at", "payment_reference"] },

  { from: "CANCELLED", action: "RECORD_REFUND", to: "SAME", roles: ["MANAGEMENT"], requires: ["amount_paise", "received_at", "reference"] },
];

export const assertVendorTransition = (
  from: VendorState,
  action: VendorAction,
  role: Parameters<typeof assertTransition>[3],
  body?: Record<string, unknown>,
) => assertTransition(VENDOR_TRANSITIONS, from, action, role, body);
