/**
 * Every write produces an audit event in the same transaction (PRD 18.2 rules 5 and 7).
 * `audit_events` is append-only: the app's DB role has no UPDATE or DELETE on it.
 */
import type { Tx } from "@/db";
import { auditEvents } from "@/db/schema";

type EntityType = typeof auditEvents.$inferInsert["entityType"];

export interface AuditInput {
  festId: string;
  entityType: EntityType;
  entityId: string;
  /** null for cron and system actions. */
  actorId: string | null;
  /** e.g. 'reimbursement.transition.APPROVE', 'line_item.document.add' */
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export async function recordAudit(tx: Tx, input: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    festId: input.festId,
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId,
    action: input.action,
    before: input.before === undefined ? null : (input.before as object),
    after: input.after === undefined ? null : (input.after as object),
    reason: input.reason ?? null,
  });
}

/**
 * The fields worth snapshotting on a state change. Full rows would bloat the log
 * and leak bank details into it; callers pass the fields that actually moved.
 */
export function snapshot<T extends object>(row: T, fields: readonly (keyof T)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) out[String(f)] = row[f];
  return out;
}
