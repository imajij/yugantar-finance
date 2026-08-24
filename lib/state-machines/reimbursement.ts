/** PRD 7.2 / 20.6 — the reimbursement state machine. */
import type { Transition } from "./types";
import { assertTransition } from "./types";

export const REIMBURSEMENT_STATES = [
  "DRAFT", "SUBMITTED", "SENT_BACK", "HOD_ENDORSED", "APPROVED", "ON_HOLD", "PAID", "DECLINED", "WITHDRAWN",
] as const;
export type ReimbursementState = (typeof REIMBURSEMENT_STATES)[number];

export const REIMBURSEMENT_TERMINAL: readonly ReimbursementState[] = ["PAID", "DECLINED", "WITHDRAWN"];

export const REIMBURSEMENT_ACTIONS = [
  "SUBMIT", "ENDORSE", "SEND_BACK", "DECLINE", "RESUBMIT", "APPROVE", "HOLD", "RESOLVE_HOLD", "RECORD_PAYMENT", "WITHDRAW",
] as const;
export type ReimbursementAction = (typeof REIMBURSEMENT_ACTIONS)[number];

type T = Transition<ReimbursementState, ReimbursementAction>;

export const REIMBURSEMENT_TRANSITIONS: readonly T[] = [
  { from: "DRAFT", action: "SUBMIT", to: "SUBMITTED", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"], actor: ["SUBMITTER"] },

  { from: "SUBMITTED", action: "ENDORSE", to: "HOD_ENDORSED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD", "NOT_SUBMITTER"] },
  { from: "SUBMITTED", action: "SEND_BACK", to: "SENT_BACK", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },
  { from: "SUBMITTED", action: "DECLINE", to: "DECLINED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },

  { from: "SENT_BACK", action: "RESUBMIT", to: "SUBMITTED", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"], actor: ["SUBMITTER"] },

  { from: "HOD_ENDORSED", action: "APPROVE", to: "APPROVED", roles: ["FINANCE_HOD", "MANAGEMENT"], actor: ["NOT_SUBMITTER"] },
  { from: "HOD_ENDORSED", action: "SEND_BACK", to: "SENT_BACK", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },
  { from: "HOD_ENDORSED", action: "DECLINE", to: "DECLINED", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },

  { from: "APPROVED", action: "HOLD", to: "ON_HOLD", roles: ["MANAGEMENT"], requires: ["reason"] },
  { from: "APPROVED", action: "RECORD_PAYMENT", to: "PAID", roles: ["MANAGEMENT"], actor: ["NOT_SUBMITTER"], requires: ["payment_reference", "paid_at"] },

  { from: "ON_HOLD", action: "RESOLVE_HOLD", to: "APPROVED", roles: ["FINANCE_HOD"], requires: ["note"] },
  { from: "ON_HOLD", action: "DECLINE", to: "DECLINED", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },

  // WITHDRAW from any non-terminal state.
  ...(["DRAFT", "SUBMITTED", "SENT_BACK", "HOD_ENDORSED", "APPROVED", "ON_HOLD"] as const).map(
    (from): T => ({ from, action: "WITHDRAW", to: "WITHDRAWN", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"], actor: ["SUBMITTER"] }),
  ),
];

/**
 * Special routing (PRD 7.2): a submitter who would otherwise endorse their own
 * request skips the endorsement step entirely.
 *
 * The test is not "is the submitter an HOD" but "is the submitter the HOD *of the
 * department this claim is against*", and the difference matters both ways:
 *
 *   - A Tech HOD claiming against Logistics' budget must still be endorsed by
 *     Logistics. Skipping on role alone would let any HOD spend another
 *     department's allocation without that department's HOD ever seeing it.
 *   - A Finance HOD claiming against the Finance department's own budget has no
 *     one else who could endorse it — `can` forbids self-endorsement and a fest has
 *     exactly one Finance HOD — so routing them through SUBMITTED strands the
 *     request with nobody able to move it.
 *
 * Applies to SUBMIT and RESUBMIT alike. Who *approves* is a separate question,
 * answered by `approverRoleFor` (5.2).
 */
export function landingStateForSubmit(
  submitterRole: string,
  /** True when the submitter is the HOD of the department the claim is charged to. */
  ownsClaimDepartment: boolean,
): ReimbursementState {
  const isHod = submitterRole === "DEPT_HOD" || submitterRole === "FINANCE_HOD";
  return isHod && ownsClaimDepartment ? "HOD_ENDORSED" : "SUBMITTED";
}

/** A Finance HOD's own request is approved by Management, not Finance (PRD 5.2). */
export function approverRoleFor(submitterRole: string): "FINANCE_HOD" | "MANAGEMENT" {
  return submitterRole === "FINANCE_HOD" ? "MANAGEMENT" : "FINANCE_HOD";
}

export const assertReimbursementTransition = (
  from: ReimbursementState,
  action: ReimbursementAction,
  role: Parameters<typeof assertTransition>[3],
  body?: Record<string, unknown>,
) => assertTransition(REIMBURSEMENT_TRANSITIONS, from, action, role, body);
