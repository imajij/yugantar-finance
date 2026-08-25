/**
 * State → semantic colour, PRD 9.1. Brand colours never encode a state,
 * and colour is never the only signal — every chip carries its label.
 */
export type StateTone = "waiting" | "moving" | "decided" | "done" | "bad" | "stuck";

const TONES: Record<StateTone, readonly string[]> = {
  waiting: ["DRAFT", "SUBMITTED", "HOD_ENDORSED", "OPEN", "NEEDS_INFO", "BACKLOG", "PLEDGED", "PENDING"],
  moving: ["ACCEPTED", "IN_PROGRESS", "ADVANCE_PAID", "DELIVERED", "PARTIALLY_RECEIVED"],
  decided: ["APPROVED", "BALANCE_APPROVED", "DONE", "COMMITTED"],
  done: ["PAID", "CLOSED", "RECEIVED", "SPENT"],
  bad: ["DECLINED", "REJECTED", "CANCELLED", "WITHDRAWN", "WRITTEN_OFF"],
  stuck: ["ON_HOLD", "BLOCKED", "SENT_BACK"],
};

const BY_STATE = new Map<string, StateTone>(
  Object.entries(TONES).flatMap(([tone, states]) => states.map((s) => [s, tone as StateTone])),
);

/** Every state the machines can hold must appear in TONES; this is what the test checks. */
export const MAPPED_STATES: ReadonlySet<string> = new Set(BY_STATE.keys());

export function toneFor(state: string): StateTone {
  return BY_STATE.get(state.toUpperCase()) ?? "waiting";
}

/** Inline style, because the colours live in CSS variables, not Tailwind's palette. */
export function chipStyle(state: string): { color: string; backgroundColor: string } {
  const tone = toneFor(state);
  return { color: `var(--state-${tone}-fg)`, backgroundColor: `var(--state-${tone}-bg)` };
}

/** SUBMITTED → "Submitted", HOD_ENDORSED → "HOD endorsed". */
export function stateLabel(state: string): string {
  const words = state.toLowerCase().split("_");
  const first = words[0] === "hod" ? "HOD" : words[0][0].toUpperCase() + words[0].slice(1);
  return [first, ...words.slice(1)].join(" ");
}

export function flagStyle(severity: "HIGH" | "MEDIUM" | "LOW"): { color: string; backgroundColor: string } {
  const key = severity.toLowerCase();
  return { color: `var(--flag-${key}-fg)`, backgroundColor: `var(--flag-${key}-bg)` };
}
