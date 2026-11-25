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
  "RELEASE_BALANCE", "RECORD_BALANCE", "RECORD_REMAINING", "CLOSE", "CANCEL", "RECORD_REFUND",
] as const;
export type VendorAction = (typeof VENDOR_ACTIONS)[number];

type T = Transition<VendorState, VendorAction>;

/**
 * Who moves vendor money out: Management, and the Finance HOD — the Finance HOD
 * even on a request they raised and approved (5.2's exception for vendor
 * payments). Who exactly is `can`'s call (`vendorRequest.recordPayment`), not an
 * actor constraint here, because the exception depends on the role.
 */
const PAYERS = ["MANAGEMENT", "FINANCE_HOD"] as const;
const PAYMENT_FIELDS = ["milestone_id", "paid_paise", "paid_at", "payment_reference"] as const;

export const VENDOR_TRANSITIONS: readonly T[] = [
  { from: "DRAFT", action: "SUBMIT", to: "SUBMITTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["SUBMITTER"] },

  // A Finance HOD may approve a request they raised, with a note (5.2); the service
  // asks for the note, `can` decides who.
  { from: "SUBMITTED", action: "APPROVE", to: "APPROVED", roles: ["FINANCE_HOD"] },
  { from: "SUBMITTED", action: "SEND_BACK", to: "SENT_BACK", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },
  { from: "SUBMITTED", action: "DECLINE", to: "DECLINED", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },

  { from: "SENT_BACK", action: "RESUBMIT", to: "SUBMITTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["SUBMITTER"] },

  // A payment may settle its milestone or pay part of it; where it lands is
  // `landingStateAfterPayment`, so `to` here is where a settling payment goes.
  { from: "APPROVED", action: "RECORD_ADVANCE", to: "ADVANCE_PAID", roles: PAYERS, requires: PAYMENT_FIELDS },
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
  { from: "BALANCE_APPROVED", action: "RECORD_BALANCE", to: "CLOSED", roles: PAYERS, requires: PAYMENT_FIELDS },

  // The rest of a milestone that was paid in part, from wherever the request has
  // got to by then — an advance paid half before delivery is still owed after it.
  ...(["APPROVED", "ADVANCE_PAID", "DELIVERED", "BALANCE_APPROVED"] as const).map(
    (from): T => ({ from, action: "RECORD_REMAINING", to: "SAME", roles: PAYERS, requires: PAYMENT_FIELDS }),
  ),

  { from: "CANCELLED", action: "RECORD_REFUND", to: "SAME", roles: ["MANAGEMENT"], requires: ["amount_paise", "received_at", "reference"] },
];

/**
 * Where a vendor payment leaves the request (7.3).
 *
 * A milestone is either settled by this payment or still partly owed, and only
 * settling moves the request on: the advance paid in full is ADVANCE_PAID, and
 * a request whose balance was released closes once nothing at all is owed. A part
 * payment leaves the request where it was, still committed for what is left.
 */
export function landingStateAfterPayment(
  from: VendorState,
  milestone: { kind: "ADVANCE" | "BALANCE" | "OTHER"; settled: boolean },
  /** Everything still owed on the request after this payment, across all milestones. */
  stillOwedPaise: number,
): VendorState {
  if (from === "BALANCE_APPROVED") return stillOwedPaise === 0 ? "CLOSED" : "BALANCE_APPROVED";
  if (from === "APPROVED" && milestone.kind === "ADVANCE" && milestone.settled) return "ADVANCE_PAID";
  return from;
}

export const assertVendorTransition = (
  from: VendorState,
  action: VendorAction,
  role: Parameters<typeof assertTransition>[3],
  body?: Record<string, unknown>,
) => assertTransition(VENDOR_TRANSITIONS, from, action, role, body);
