/** PRD 7.5 / 20.5 — line-item lifecycle. */
import type { Transition } from "./types";
import { assertTransition } from "./types";

export const LINE_ITEM_STATES = ["OPEN", "CLOSED"] as const;
export type LineItemState = (typeof LINE_ITEM_STATES)[number];

export const LINE_ITEM_ACTIONS = ["CLOSE", "REOPEN", "MARK_REVIEWED", "UNMARK_REVIEWED"] as const;
export type LineItemAction = (typeof LINE_ITEM_ACTIONS)[number];

type T = Transition<LineItemState, LineItemAction>;

export const LINE_ITEM_TRANSITIONS: readonly T[] = [
  { from: "OPEN", action: "CLOSE", to: "CLOSED", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["reason"] },
  { from: "CLOSED", action: "REOPEN", to: "OPEN", roles: ["DEPT_HOD", "FINANCE_HOD"], actor: ["TARGET_DEPT_HOD"], requires: ["reason"] },
  { from: "OPEN", action: "MARK_REVIEWED", to: "SAME", roles: ["FINANCE_HOD"] },
  { from: "CLOSED", action: "MARK_REVIEWED", to: "SAME", roles: ["FINANCE_HOD"] },
  { from: "OPEN", action: "UNMARK_REVIEWED", to: "SAME", roles: ["FINANCE_HOD"] },
  { from: "CLOSED", action: "UNMARK_REVIEWED", to: "SAME", roles: ["FINANCE_HOD"] },
];

export const assertLineItemTransition = (
  from: LineItemState,
  action: LineItemAction,
  role: Parameters<typeof assertTransition>[3],
  body?: Record<string, unknown>,
) => assertTransition(LINE_ITEM_TRANSITIONS, from, action, role, body);
