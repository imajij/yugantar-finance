/**
 * Every write produces an audit event in the same transaction (PRD 18.2 rules 5 and 7).
 * `audit_events` is append-only: the app's DB role has no UPDATE or DELETE on it.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditEvents } from "@/db/schema";
import { assertCan, canFestWide, type Actor } from "@/lib/authz";

export type EntityType = NonNullable<typeof auditEvents.$inferInsert["entityType"]>;

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

/* ------------------------------------------------------------- reading it */

/**
 * Reading the log (PRD 20.10). Finance and Management see the whole fest; a Dept
 * HOD sees their own department's records.
 *
 * "Their own department" has to be worked out by joining each event back to the
 * entity it describes, because `audit_events` deliberately stores no department of
 * its own — a reallocation would otherwise leave old events pointing at the wrong
 * one. The lateral union below is that join, and it is the only place it exists.
 */
const DEPARTMENT_OF_ENTITY = sql`
  left join lateral (
    select r.department_id from reimbursement_requests r
      where a.entity_type = 'REIMBURSEMENT' and r.id = a.entity_id
    union all
    select v.department_id from vendor_requests v
      where a.entity_type = 'VENDOR_REQUEST' and v.id = a.entity_id
    union all
    select li.department_id from line_items li
      where a.entity_type = 'LINE_ITEM' and li.id = a.entity_id
    union all
    select t.requesting_department_id from tickets t
      where a.entity_type = 'TICKET' and t.id = a.entity_id
    union all
    select t2.target_department_id from tickets t2
      where a.entity_type = 'TICKET' and t2.id = a.entity_id
    union all
    select a.entity_id from (select 1) _
      where a.entity_type = 'DEPARTMENT'
  ) scope(department_id) on true
`;

export interface AuditFilters {
  entityType?: EntityType;
  entityId?: string;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  before?: Date;
  limit?: number;
}

export interface AuditRow {
  id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  reason: string | null;
  before: unknown;
  after: unknown;
  created_at: Date;
  actor: string | null;
  actor_id: string | null;
}

export async function readAuditLog(actor: Actor, filters: AuditFilters = {}): Promise<AuditRow[]> {
  assertCan(actor, "audit.view", { festId: actor.festId, departmentId: actor.departmentId });
  const festWide = canFestWide(actor, "audit.view");
  const limit = Math.min(filters.limit ?? 100, 500);

  return (await db.execute(sql`
    select distinct a.id, a.entity_type, a.entity_id, a.action, a.reason,
           a.before, a.after, a.created_at, u.name as actor, a.actor_id
      from audit_events a
      left join users u on u.id = a.actor_id
      ${festWide ? sql`` : DEPARTMENT_OF_ENTITY}
     where a.fest_id = ${actor.festId}
       ${festWide ? sql`` : sql`and scope.department_id = ${actor.departmentId}`}
       ${filters.entityType ? sql`and a.entity_type = ${filters.entityType}` : sql``}
       ${filters.entityId ? sql`and a.entity_id = ${filters.entityId}` : sql``}
       ${filters.actorId ? sql`and a.actor_id = ${filters.actorId}` : sql``}
       ${filters.action ? sql`and a.action ilike ${`%${filters.action}%`}` : sql``}
       ${filters.from ? sql`and a.created_at >= ${filters.from}::date` : sql``}
       ${filters.to ? sql`and a.created_at < (${filters.to}::date + 1)` : sql``}
       ${filters.before ? sql`and a.created_at < ${filters.before}` : sql``}
     order by a.created_at desc
     limit ${limit}
  `)) as unknown as AuditRow[];
}

/**
 * The timeline on a detail screen (20.1). Visibility follows the record itself, so
 * a Member sees the history of their own request without being able to read the log.
 */
export async function entityTimeline(actor: Actor, entityType: EntityType, entityId: string): Promise<AuditRow[]> {
  return (await db.execute(sql`
    select a.id, a.entity_type, a.entity_id, a.action, a.reason,
           a.before, a.after, a.created_at, u.name as actor, a.actor_id
      from audit_events a
      left join users u on u.id = a.actor_id
     where a.fest_id = ${actor.festId}
       and a.entity_type = ${entityType}
       and a.entity_id = ${entityId}
     order by a.created_at asc
  `)) as unknown as AuditRow[];
}
