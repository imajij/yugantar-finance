/**
 * The flag queue (PRD 8.3, 20.10).
 *
 * Flags are advisory, never blocking (21.4): the point is that somebody looked. So
 * the two resolutions are ACKNOWLEDGE ("seen, and here is why it is fine") and
 * DISMISS ("this rule misfired") — both demand a note, and both are audited. A flag
 * that quietly disappears teaches people to ignore the next one.
 *
 * Re-running the rules is idempotent: `evaluate*Flags` opens what fires and closes
 * what no longer does, so `/flags/evaluate` is safe to call as often as you like.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, flags } from "@/db/schema";
import { ApiError, notFound } from "@/lib/api";
import { assertCan, can, canFestWide } from "@/lib/authz";
import {
  evaluateLineItemFlags, evaluateReimbursementFlags, evaluateVendorFlags,
} from "@/lib/flags";
import { resolveEntity, VIEW_ACTION, type EntityType } from "@/lib/entities";
import type { SessionUser } from "@/lib/session";
import { recordAudit } from "./audit";

export type FlaggableType = Extract<EntityType, "REIMBURSEMENT" | "VENDOR_REQUEST" | "LINE_ITEM">;

export const FLAGGABLE: FlaggableType[] = ["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM"];

export interface FlagFilters {
  status?: "OPEN" | "ACKNOWLEDGED" | "DISMISSED";
  entityType?: FlaggableType;
  severity?: "HIGH" | "MEDIUM" | "LOW";
  limit?: number;
}

/** Severity first, then age — the oldest High flag is the one holding up a payment. */
const BY_SEVERITY_THEN_AGE = sql`case severity when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`;

/**
 * Finance sees every flag; a Dept HOD sees the ones on their own department's
 * records. The department is joined through each entity's own table rather than
 * denormalised onto `flags`, so a reallocation cannot leave a flag mis-scoped.
 */
export async function listFlags(actor: SessionUser, filters: FlagFilters = {}) {
  assertCan(actor, "flag.view", { festId: actor.festId, departmentId: actor.departmentId });
  const financeWide = canFestWide(actor, "flag.view");

  const rows = (await db.execute(sql`
    select f.id, f.rule, f.severity, f.status, f.explanation, f.created_at,
           f.entity_type, f.entity_id, f.resolution_note, f.resolved_at,
           ru.name as resolved_by_name,
           e.department_id, d.name as department_name, e.human_id, e.status as entity_status
      from flags f
      join lateral (
        select r.department_id, r.human_id, r.status::text as status
          from reimbursement_requests r where f.entity_type = 'REIMBURSEMENT' and r.id = f.entity_id
        union all
        select v.department_id, v.human_id, v.status::text
          from vendor_requests v where f.entity_type = 'VENDOR_REQUEST' and v.id = f.entity_id
        union all
        select li.department_id, li.name, li.status::text
          from line_items li where f.entity_type = 'LINE_ITEM' and li.id = f.entity_id
      ) e on true
      join departments d on d.id = e.department_id
      left join users ru on ru.id = f.resolved_by
     where f.fest_id = ${actor.festId}
       and f.status = ${filters.status ?? "OPEN"}
       ${filters.entityType ? sql`and f.entity_type = ${filters.entityType}` : sql``}
       ${filters.severity ? sql`and f.severity = ${filters.severity}` : sql``}
       ${financeWide ? sql`` : sql`and e.department_id = ${actor.departmentId}`}
     order by ${BY_SEVERITY_THEN_AGE}, f.created_at
     limit ${filters.limit ?? 100}
  `)) as unknown as Record<string, unknown>[];

  return rows;
}

/** The count the dashboards show. Same scoping rules as the list. */
export async function openFlagCounts(actor: SessionUser): Promise<{ high: number; medium: number; low: number; total: number }> {
  const financeWide = canFestWide(actor, "flag.view");
  if (!can(actor, "flag.view", { festId: actor.festId, departmentId: actor.departmentId })) {
    return { high: 0, medium: 0, low: 0, total: 0 };
  }

  const rows = (await db.execute(sql`
    select f.severity, count(*)::int as n
      from flags f
      join lateral (
        select r.department_id from reimbursement_requests r
          where f.entity_type = 'REIMBURSEMENT' and r.id = f.entity_id
        union all
        select v.department_id from vendor_requests v
          where f.entity_type = 'VENDOR_REQUEST' and v.id = f.entity_id
        union all
        select li.department_id from line_items li
          where f.entity_type = 'LINE_ITEM' and li.id = f.entity_id
      ) e on true
     where f.fest_id = ${actor.festId} and f.status = 'OPEN'
       ${financeWide ? sql`` : sql`and e.department_id = ${actor.departmentId}`}
     group by f.severity
  `)) as unknown as { severity: string; n: number }[];

  const by = Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]));
  const high = by.HIGH ?? 0, medium = by.MEDIUM ?? 0, low = by.LOW ?? 0;
  return { high, medium, low, total: high + medium + low };
}

export type FlagAction = "ACKNOWLEDGE" | "DISMISS";

/**
 * Finance resolves flags (5.1). Both actions need a note: "acknowledged" with no
 * reason is indistinguishable from nobody having looked.
 */
export async function resolveFlag(actor: SessionUser, id: string, action: FlagAction, note: string) {
  assertCan(actor, "flag.resolve", { festId: actor.festId });
  if (!note?.trim()) {
    throw new ApiError("VALIDATION_ERROR", `${action === "DISMISS" ? "A reason" : "A note"} is required`);
  }

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(flags)
      .where(and(eq(flags.id, id), eq(flags.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Flag");
    if (before.status !== "OPEN") {
      throw new ApiError("INVALID_TRANSITION", `That flag is already ${before.status.toLowerCase()}`);
    }

    const [after] = await tx.update(flags).set({
      status: action === "ACKNOWLEDGE" ? "ACKNOWLEDGED" : "DISMISSED",
      resolvedBy: actor.id,
      resolvedAt: new Date(),
      resolutionNote: note.trim(),
    }).where(eq(flags.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId,
      entityType: before.entityType,
      entityId: before.entityId,
      actorId: actor.id,
      action: `flag.${action.toLowerCase()}`,
      before: { rule: before.rule, severity: before.severity, status: before.status },
      after: { status: after.status },
      reason: note.trim(),
    });
    return after;
  });
}

/** 20.10 `/flags/evaluate` — re-runs the rule set for one record. */
export async function evaluateFor(actor: SessionUser, entityType: FlaggableType, entityId: string) {
  assertCan(actor, "flag.resolve", { festId: actor.festId });
  // The record has to exist in this fest and be one the caller could see anyway.
  const resource = await resolveEntity(actor.festId, entityType, entityId);
  if (!can(actor, VIEW_ACTION[entityType], resource)) {
    throw new ApiError("FORBIDDEN", "You cannot see that record");
  }

  return db.transaction(async (tx) => {
    const results =
      entityType === "REIMBURSEMENT" ? await evaluateReimbursementFlags(tx, entityId)
      : entityType === "VENDOR_REQUEST" ? await evaluateVendorFlags(tx, entityId)
      : await evaluateLineItemFlags(tx, entityId);

    await recordAudit(tx, {
      festId: actor.festId, entityType, entityId, actorId: actor.id,
      action: "flag.evaluate", after: { firing: results.map((r) => r.rule) },
    });
    return { entity_type: entityType, entity_id: entityId, flags: results };
  });
}

/** Open flags on a set of records, for the queue screens. One query, not N. */
export async function openFlagsByEntity(entityType: FlaggableType, ids: string[]) {
  if (ids.length === 0) return new Map<string, { rule: string; severity: string; explanation: string }[]>();
  const rows = await db.select({
    entityId: flags.entityId, rule: flags.rule, severity: flags.severity, explanation: flags.explanation,
  }).from(flags)
    .where(and(eq(flags.entityType, entityType), inArray(flags.entityId, ids), eq(flags.status, "OPEN")))
    .orderBy(BY_SEVERITY_THEN_AGE, desc(flags.createdAt));

  const map = new Map<string, { rule: string; severity: string; explanation: string }[]>();
  for (const r of rows) {
    const list = map.get(r.entityId) ?? [];
    list.push({ rule: r.rule, severity: r.severity, explanation: r.explanation });
    map.set(r.entityId, list);
  }
  return map;
}

/** Departments a Dept HOD may filter by — used to build the flag screen's controls. */
export async function visibleDepartments(actor: SessionUser) {
  const financeWide = canFestWide(actor, "flag.view");
  return db.select({ id: departments.id, name: departments.name }).from(departments)
    .where(and(
      eq(departments.festId, actor.festId),
      eq(departments.isActive, true),
      financeWide ? undefined : eq(departments.id, actor.departmentId),
    ))
    .orderBy(departments.name);
}
