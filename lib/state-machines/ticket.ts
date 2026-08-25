/** PRD 7.7 / 20.9 — the work-ticket state machine. */
import type { Transition } from "./types";
import { assertTransition } from "./types";

export const TICKET_STATES = [
  "OPEN", "NEEDS_INFO", "BACKLOG", "ACCEPTED", "IN_PROGRESS", "BLOCKED", "DONE", "CLOSED", "REJECTED", "CANCELLED",
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export const TICKET_TERMINAL: readonly TicketState[] = ["CLOSED", "REJECTED", "CANCELLED"];

export const TICKET_ACTIONS = [
  "ACCEPT", "BACKLOG", "SCHEDULE", "ASK_INFO", "REPLY_INFO", "REJECT", "START", "BLOCK", "UNBLOCK",
  "MARK_DONE", "CONFIRM", "REOPEN", "REASSIGN", "CANCEL", "ESCALATE",
] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

type T = Transition<TicketState, TicketAction>;

const ANY_ROLE = ["MEMBER", "DEPT_HOD", "FINANCE_HOD", "MANAGEMENT"] as const;

export const TICKET_TRANSITIONS: readonly T[] = [
  { from: "OPEN", action: "ACCEPT", to: "ACCEPTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"] },
  { from: "OPEN", action: "REJECT", to: "REJECTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["reason"] },

  // Backlog is the third answer to a triage decision, and the one that was missing:
  // "yes, this is ours — and not this week". Without it a department either takes on
  // work it cannot schedule or rejects work it actually intends to do, and the
  // inbox count stops meaning anything. ACCEPTED is Todo; BACKLOG is not-yet.
  { from: "OPEN", action: "BACKLOG", to: "BACKLOG", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"] },
  { from: "ACCEPTED", action: "BACKLOG", to: "BACKLOG", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"] },
  { from: "BACKLOG", action: "SCHEDULE", to: "ACCEPTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"] },
  { from: "BACKLOG", action: "REJECT", to: "REJECTED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["reason"] },

  ...(["OPEN", "BACKLOG", "ACCEPTED", "IN_PROGRESS"] as const).map((from): T => ({
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

  ...(["OPEN", "NEEDS_INFO", "BACKLOG", "ACCEPTED", "IN_PROGRESS", "BLOCKED", "DONE"] as const).map((from): T => ({
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

/**
 * Linear's other axis: what a state *means* on a board.
 *
 * A board has five or six columns; this state machine has ten states, because the
 * states answer a governance question (who may do what next) and the columns answer
 * a planning one (is this waiting, moving, or finished). Collapsing states into
 * categories here — rather than in the board component — keeps the two from
 * drifting: add a state and the compiler demands a category for it.
 */
export const TICKET_CATEGORIES = [
  "TRIAGE", "BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED",
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const CATEGORY_OF: Record<TicketState, TicketCategory> = {
  OPEN: "TRIAGE",
  NEEDS_INFO: "TRIAGE",
  BACKLOG: "BACKLOG",
  ACCEPTED: "TODO",
  IN_PROGRESS: "IN_PROGRESS",
  BLOCKED: "IN_PROGRESS",
  DONE: "DONE",
  CLOSED: "DONE",
  REJECTED: "CANCELLED",
  CANCELLED: "CANCELLED",
};

export const CATEGORY_LABEL: Record<TicketCategory, string> = {
  TRIAGE: "Triage",
  BACKLOG: "Backlog",
  TODO: "Todo",
  IN_PROGRESS: "In Progress",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

export const statesIn = (category: TicketCategory): TicketState[] =>
  TICKET_STATES.filter((s) => CATEGORY_OF[s] === category);

/**
 * Dragging a card into a column has to become a transition, because a status is
 * never written directly (18.2 rule 2). This is the ordered list of actions to try
 * for a drop: the first one legal from the card's current state wins, and if none
 * is, the drop is refused with the reason — which is how a board stays honest about
 * a state machine underneath it.
 */
export const CATEGORY_ENTRY_ACTIONS: Record<TicketCategory, readonly TicketAction[]> = {
  TRIAGE: [],                                   // nothing moves *back* into triage
  BACKLOG: ["BACKLOG"],
  TODO: ["SCHEDULE", "ACCEPT", "UNBLOCK", "REOPEN"],
  IN_PROGRESS: ["START", "UNBLOCK", "REOPEN"],
  DONE: ["MARK_DONE", "CONFIRM"],
  CANCELLED: ["REJECT", "CANCEL"],
};

/** The actions legal from a state for a role, for the inline status menu. */
export function actionsFrom(from: TicketState): TicketAction[] {
  const seen = new Set<TicketAction>();
  for (const t of TICKET_TRANSITIONS) if (t.from === from) seen.add(t.action);
  return [...seen];
}
