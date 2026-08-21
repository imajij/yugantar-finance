/** PRD 7.7 / 20.9 — the work-ticket state machine. */
import type { Transition } from "./types";
import { assertTransition } from "./types";

export const TICKET_STATES = [
  "OPEN", "NEEDS_INFO", "ACCEPTED", "IN_PROGRESS", "BLOCKED", "DONE", "CLOSED", "REJECTED", "CANCELLED",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const TICKET_TERMINAL: readonly TicketState[] = ["CLOSED", "REJECTED", "CANCELLED"];

export const TICKET_ACTIONS = [
  "ACCEPT", "ASK_INFO", "REPLY_INFO", "REJECT", "START", "BLOCK", "UNBLOCK",
  "MARK_DONE", "CONFIRM", "REOPEN", "REASSIGN", "CANCEL", "ESCALATE",
] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

type T = Transition<TicketState, TicketAction>;

const ANY_ROLE = ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"] as const;

export const TICKET_TRANSITIONS: readonly T[] = [
  { from: "OPEN", action: "ACCEPT", to: "ACCEPTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"] },
  { from: "OPEN", action: "REJECT", to: "REJECTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["reason"] },

  ...(["OPEN", "ACCEPTED", "IN_PROGRESS"] as const).map((from): T => ({
    from, action: "ASK_INFO", to: "NEEDS_INFO", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD"], requires: ["question"],
  })),
  { from: "NEEDS_INFO", action: "REPLY_INFO", to: "PREVIOUS", roles: [...ANY_ROLE], actor: ["REQUESTER"], requires: ["answer"] },

  { from: "ACCEPTED", action: "START", to: "IN_PROGRESS", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD"], actor: ["ASSIGNEE"] },
  { from: "IN_PROGRESS", action: "BLOCK", to: "BLOCKED", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD"], actor: ["ASSIGNEE"], requires: ["reason"] },
  { from: "BLOCKED", action: "UNBLOCK", to: "IN_PROGRESS", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD"] },

  { from: "ACCEPTED", action: "MARK_DONE", to: "DONE", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD"] },
  { from: "IN_PROGRESS", action: "MARK_DONE", to: "DONE", roles: ["MEMBER", "DEPT_HOD", "FINANCE_HOD"] },

  { from: "DONE", action: "CONFIRM", to: "CLOSED", roles: [...ANY_ROLE], actor: ["REQUESTER"] },
  { from: "DONE", action: "REOPEN", to: "IN_PROGRESS", roles: [...ANY_ROLE], actor: ["REQUESTER"], requires: ["reason"] },

  ...(["ACCEPTED", "IN_PROGRESS", "BLOCKED"] as const).map((from): T => ({
    from, action: "REASSIGN", to: "SAME", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["assignee_id"],
  })),

  ...(["OPEN", "NEEDS_INFO", "ACCEPTED", "IN_PROGRESS", "BLOCKED", "DONE"] as const).map((from): T => ({
    from, action: "CANCEL", to: "CANCELLED", roles: [...ANY_ROLE], actor: ["REQUESTER"],
  })),

  // Escalation marks the ticket; it never changes state (PRD 7.7).
  { from: "OPEN", action: "ESCALATE", to: "SAME", roles: [...ANY_ROLE] },
  { from: "BLOCKED", action: "ESCALATE", to: "SAME", roles: [...ANY_ROLE] },
  { from: "REJECTED", action: "ESCALATE", to: "SAME", roles: [...ANY_ROLE] },
];

export const assertTicketTransition = (
  from: TicketState,
  action: TicketAction,
  role: Parameters<typeof assertTransition>[3],
  body?: Record<string, unknown>,
) => assertTransition(TICKET_TRANSITIONS, from, action, role, body);
