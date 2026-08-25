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
import { label, resolveEntity, VIEW_ACTION, type EntityType } from "@/lib/entities";
import type { SessionUser } from "@/lib/session";
import { recordAudit } from "./audit";
import { notify, type NotifyEntity } from "./notifications";

export type FlaggableType = Extract<EntityType, "REIMBURSEMENT" | "VENDOR_REQUEST" | "LINE_ITEM">;

export const FLAGGABLE: FlaggableType[] = ["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM"];

/**
 * What a person may flag by hand, which is wider than what the rules run on.
 *
 * F1–F14 examine a record and its numbers, so they only fire on records with
 * numbers. A person's concern is often about neither: "Logistics has been sitting
 * on unreviewed line items for a fortnight", "this HOD approved their own team's
 * request twice". Those are about a department or a person, and until now there was
 * nowhere to put them except a message that nobody could resolve or count.
 */
export type ManualFlaggableType = FlaggableType | "DEPARTMENT" | "USER";

export const MANUALLY_FLAGGABLE: ManualFlaggableType[] = [
  "REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM", "DEPARTMENT", "USER",
];

/** The rule name a hand-raised flag carries, so the queue can tell them apart. */
export const MANUAL_RULE = "MANUAL";

export interface FlagFilters {
  status?: "OPEN" | "ACKNOWLEDGED" | "DISMISSED";
  entityType?: ManualFlaggableType;
  severity?: "HIGH" | "MEDIUM" | "LOW";
  /** "raised by a person" vs "raised by a rule". */
  source?: "MANUAL" | "RULE";
  limit?: number;
}

/**
 * The department, label and state of whatever a flag points at, whichever table
 * that is.
 *
 * The department is joined through the entity's own row rather than denormalised
 * onto `flags`, so a reallocation cannot leave a flag mis-scoped — that is what
 * decides whether an HOD sees it. A flag on a *department* answers with itself; one
 * on a *person* answers with the department they belong to, which is what makes
 * "this HOD keeps doing X" visible to Finance and to that department, and to
 * nobody else.
 */
const ENTITY_FACTS = sql`
  select r.department_id, r.human_id, r.status::text as status
    from reimbursement_requests r where f.entity_type = 'REIMBURSEMENT' and r.id = f.entity_id
  union all
  select v.department_id, v.human_id, v.status::text
    from vendor_requests v where f.entity_type = 'VENDOR_REQUEST' and v.id = f.entity_id
  union all
  select li.department_id, li.name, li.status::text
    from line_items li where f.entity_type = 'LINE_ITEM' and li.id = f.entity_id
  union all
  select dep.id, dep.name, case when dep.is_active then 'ACTIVE' else 'INACTIVE' end
    from departments dep where f.entity_type = 'DEPARTMENT' and dep.id = f.entity_id
  union all
  select u.department_id, u.name, u.status::text
    from users u where f.entity_type = 'USER' and u.id = f.entity_id
`;

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
           f.raised_by as raised_by_id, qu.name as raised_by_name,
           (f.raised_by is not null) as is_manual,
           e.department_id, d.name as department_name, e.human_id, e.status as entity_status
      from flags f
      join lateral (${ENTITY_FACTS}) e on true
      join departments d on d.id = e.department_id
      left join users ru on ru.id = f.resolved_by
      left join users qu on qu.id = f.raised_by
     where f.fest_id = ${actor.festId}
       and f.status = ${filters.status ?? "OPEN"}
       ${filters.entityType ? sql`and f.entity_type = ${filters.entityType}` : sql``}
       ${filters.severity ? sql`and f.severity = ${filters.severity}` : sql``}
       ${filters.source === "MANUAL" ? sql`and f.raised_by is not null` : sql``}
       ${filters.source === "RULE" ? sql`and f.raised_by is null` : sql``}
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
      join lateral (${ENTITY_FACTS}) e on true
     where f.fest_id = ${actor.festId} and f.status = 'OPEN'
       ${financeWide ? sql`` : sql`and e.department_id = ${actor.departmentId}`}
     group by f.severity
  `)) as unknown as { severity: string; n: number }[];

  const by = Object.fromEntries(rows.map((r) => [r.severity, Number(r.n)]));
  const high = by.HIGH ?? 0, medium = by.MEDIUM ?? 0, low = by.LOW ?? 0;
  return { high, medium, low, total: high + medium + low };
}

export interface RaiseFlagInput {
  entityType: ManualFlaggableType;
  entityId: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  explanation: string;
}

/**
 * A person raising a concern (8.3).
 *
 * Deliberately wider than `flag.resolve`: whoever notices is rarely whoever clears
 * it, and an HOD watching their own department is usually who notices first. What
 * may be flagged is not decided by the action but by whether the caller can see the
 * thing — a UUID is not a secret (18.2 rule 10), so the target is resolved from its
 * own row and checked, never taken on the client's word.
 *
 * Unlike a rule's flag these are not deduplicated: two people noticing two
 * different things about one record is exactly what should be allowed, and the
 * partial unique index is scoped to rule-raised flags for that reason.
 */
export async function raiseFlag(actor: SessionUser, input: RaiseFlagInput) {
  assertCan(actor, "flag.raise", { festId: actor.festId, departmentId: actor.departmentId });

  const explanation = input.explanation.trim();
  if (explanation.length < 10) {
    throw new ApiError("VALIDATION_ERROR", "Say what is wrong — at least 10 characters");
  }
  if (!MANUALLY_FLAGGABLE.includes(input.entityType)) {
    throw new ApiError("VALIDATION_ERROR", `${input.entityType} cannot be flagged`);
  }

  const resource = await resolveEntity(actor.festId, input.entityType, input.entityId);

  // A department and a person are not records with a submitter, so the question is
  // not "may you read this row" but "is this yours to raise". Both answer to the
  // department: your own, or every one if you oversee the fest.
  const visible =
    input.entityType === "DEPARTMENT" || input.entityType === "USER"
      ? can(actor, "department.view", { festId: actor.festId, departmentId: resource.departmentId })
      : can(actor, VIEW_ACTION[input.entityType], resource);
  if (!visible) throw new ApiError("FORBIDDEN", "You cannot see that record");

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(flags).values({
      festId: actor.festId,
      entityType: input.entityType,
      entityId: input.entityId,
      rule: MANUAL_RULE,
      severity: input.severity,
      explanation,
      raisedBy: actor.id,
    }).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: input.entityType, entityId: input.entityId, actorId: actor.id,
      action: "flag.raise",
      after: { flag_id: row.id, severity: row.severity },
      reason: explanation,
    });

    // High is the severity that means "do not pay this yet", so Finance hears about
    // it now rather than on the next time somebody opens the queue.
    if (input.severity === "HIGH") {
      await notify(tx, {
        festId: actor.festId,
        type: "flag.raised",
        title: `${actor.name} raised a High concern`,
        body: explanation,
        entityType: NOTIFY_TARGET[input.entityType],
        entityId: input.entityId,
        toRoles: ["FINANCE_HOD"],
        exceptUserId: actor.id,
        blocks: [
          { label: "Raised by", value: actor.name },
          { label: "About", value: label(input.entityType) },
        ],
      });
    }

    return row;
  });
}

/** Where a notification about a flagged thing should land. */
const NOTIFY_TARGET: Record<ManualFlaggableType, NotifyEntity> = {
  REIMBURSEMENT: "REIMBURSEMENT",
  VENDOR_REQUEST: "VENDOR_REQUEST",
  LINE_ITEM: "LINE_ITEM",
  DEPARTMENT: "DEPARTMENT",
  USER: "FEST",
};

/**
 * Taking back your own concern.
 *
 * Resolving a flag is Finance's call, and stays so. But a flag raised by hand can
 * simply be a mistake — wrong record, or answered five minutes later — and the
 * person who raised it should not have to ask Finance to clear up after them. It
 * resolves as DISMISSED with a note, like any other resolution, so nothing
 * disappears from the count without a reason attached.
 */
export async function withdrawFlag(actor: SessionUser, id: string, note: string) {
  if (!note?.trim()) throw new ApiError("VALIDATION_ERROR", "Say why you are withdrawing it");

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(flags)
      .where(and(eq(flags.id, id), eq(flags.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Flag");
    if (before.raisedBy !== actor.id) {
      throw new ApiError("FORBIDDEN", "Only whoever raised a concern can withdraw it");
    }
    if (before.status !== "OPEN") {
      throw new ApiError("INVALID_TRANSITION", `That flag is already ${before.status.toLowerCase()}`);
    }

    const [after] = await tx.update(flags).set({
      status: "DISMISSED",
      resolvedBy: actor.id,
      resolvedAt: new Date(),
      resolutionNote: `Withdrawn by ${actor.name}: ${note.trim()}`,
    }).where(eq(flags.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: before.entityType, entityId: before.entityId, actorId: actor.id,
      action: "flag.withdraw",
      before: { severity: before.severity, status: before.status },
      after: { status: after.status },
      reason: note.trim(),
    });
    return after;
  });
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
