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
  /*
   * Finance is on this list only for 5.2's fallback: a Management user's own claim,
   * in a fest with a single Management account, which nobody else could ever pay.
   * The table says who may in principle; `can` decides whether this caller may here
   * (`reimbursement.recordPayment`), and the service requires the note.
   */
  { from: "APPROVED", action: "RECORD_PAYMENT", to: "PAID", roles: ["MANAGEMENT", "FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["payment_reference", "paid_at"] },

  { from: "ON_HOLD", action: "RESOLVE_HOLD", to: "APPROVED", roles: ["FINANCE_HOD"], requires: ["note"] },
  { from: "ON_HOLD", action: "DECLINE", to: "DECLINED", roles: ["FINANCE_HOD"], actor: ["NOT_SUBMITTER"], requires: ["reason"] },

  // WITHDRAW from any non-terminal state.
  ...(["DRAFT", "SUBMITTED", "SENT_BACK", "HOD_ENDORSED", "APPROVED", "ON_HOLD"] as const).map(
    (from): T => ({ from, action: "WITHDRAW", to: "WITHDRAWN", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"], actor: ["SUBMITTER"] }),
  ),
];

/**
 * Special routing (PRD 7.2): a submitter who would otherwise endorse their own
 * request skips the endorsement step.
 *
 * Three conditions, and each rules out a different way of getting this wrong:
 *
 *   - **The submitter is an HOD.** A Member is always endorsed.
 *   - **Of the department the claim is charged to.** A Tech HOD claiming against
 *     Logistics' budget must still be endorsed by Logistics; routing on role alone
 *     would let one department spend another's allocation unseen.
 *   - **And has no peer who could endorse it instead.** 7.2 skips the step because
 *     the only eligible endorser is the submitter, which stops being true the moment
 *     a department has a second head. Where a peer exists, they review it — that is
 *     what endorsement is for, and a fest may have several heads per department.
 *
 * The third is why a single Finance HOD claiming against Finance's own budget is not
 * stranded: nobody else can endorse it, so the step is skipped rather than waiting
 * for someone who does not exist. Add a second Finance-department head and their
 * claims start being reviewed, with no code change.
 *
 * Applies to SUBMIT and RESUBMIT alike. Who *approves* is a separate question,
 * answered by `approverRoleFor` (5.2).
 */
export function landingStateForSubmit(
  submitterRole: string,
  /** True when the submitter is the HOD of the department the claim is charged to. */
  ownsClaimDepartment: boolean,
  /** True when another head of that department could endorse it instead. */
  peerEndorserExists: boolean,
): ReimbursementState {
  const isHod = submitterRole === "DEPT_HOD" || submitterRole === "FINANCE_HOD";
  const wouldEndorseThemselves = isHod && ownsClaimDepartment && !peerEndorserExists;
  return wouldEndorseThemselves ? "HOD_ENDORSED" : "SUBMITTED";
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
