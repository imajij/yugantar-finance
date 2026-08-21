/**
 * Transition tables are data, not code (PRD 18.2 rule 2).
 * Route handlers never branch on status; they call assertTransition.
 */
export type Role = "MEMBER" | "DEPT_HOD" | "FINANCE_HOD" | "MANAGEMENT";

/** Who may fire a transition, beyond holding the right role. */
export type ActorConstraint =
  | "SUBMITTER"           // the person who created the record
  | "NOT_SUBMITTER"       // segregation of duties: anyone but the creator
  | "TARGET_DEPT_HOD"     // HOD of the record's / ticket's target department
  | "REQUESTING_DEPT_HOD" // HOD of the department that raised the ticket
  | "ASSIGNEE"            // the ticket's assignee
  | "REQUESTER";          // the ticket's requester

export interface Transition<S extends string, A extends string> {
  from: S;
  action: A;
  to: S | "SAME" | "PREVIOUS";
  roles: readonly Role[];
  /** All must hold. Empty = role alone is enough. */
  actor?: readonly ActorConstraint[];
  /** Body fields the endpoint must receive (PRD 20.6 / 20.7 / 20.9). */
  requires?: readonly string[];
}

export class InvalidTransition extends Error {
  readonly code = "INVALID_TRANSITION";
  constructor(message: string) {
    super(message);
    this.name = "InvalidTransition";
  }
}

export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";
  constructor(message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ValidationError";
  }
}

/** Look up a transition and check role + required fields. Actor constraints are checked by `can`. */
export function assertTransition<S extends string, A extends string>(
  table: readonly Transition<S, A>[],
  from: S,
  action: A,
  role: Role,
  body: Record<string, unknown> = {},
): Transition<S, A> {
  const forAction = table.filter((t) => t.action === action);
  if (forAction.length === 0) throw new InvalidTransition(`Unknown action ${action}`);

  const match = forAction.filter((t) => t.from === from);
  if (match.length === 0) {
    throw new InvalidTransition(`${action} is not allowed from ${from}`);
  }

  const allowed = match.find((t) => t.roles.includes(role));
  if (!allowed) {
    throw new InvalidTransition(`${role} may not ${action} from ${from}`);
  }

  const missing = (allowed.requires ?? []).filter(
    (f) => body[f] === undefined || body[f] === null || body[f] === "",
  );
  if (missing.length > 0) {
    throw new ValidationError(`${action} requires ${missing.join(", ")}`, { missing });
  }
  return allowed;
}

/** Every from × action pair the table covers — used by the exhaustive tests. */
export function pairs<S extends string, A extends string>(
  table: readonly Transition<S, A>[],
): Set<string> {
  return new Set(table.map((t) => `${t.from}:${t.action}`));
}
