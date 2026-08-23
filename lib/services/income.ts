/**
 * Income (PRD 7.4, 20.8). Sponsorship cash, in-kind, event tickets, grants.
 * In-kind is recorded for completeness but never counts toward cash — that exclusion
 * lives in `v_fest_totals`, not here.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { attachments, incomeEntries, incomeTranches, users } from "@/db/schema";
import { ApiError, notFound } from "@/lib/api";
import { assertCan, type Actor } from "@/lib/authz";
import { recordAudit, snapshot } from "./audit";

const AUDITED = ["type", "sourceName", "pledgedPaise", "status", "owningDepartmentId"] as const;

export type IncomeType = "SPONSORSHIP_CASH" | "SPONSORSHIP_IN_KIND" | "EVENT_TICKETS" | "COLLEGE_GRANT" | "OTHER";

export interface IncomeInput {
  type: IncomeType;
  sourceName: string;
  owningDepartmentId?: string | null;
  pledgedPaise: number;
  pledgedOn?: string | null;
  notes?: string | null;
  attachmentIds?: string[];
}

export async function createIncome(actor: Actor, input: IncomeInput) {
  assertCan(actor, "income.manage", { festId: actor.festId });
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(incomeEntries).values({
      festId: actor.festId,
      type: input.type,
      sourceName: input.sourceName,
      owningDepartmentId: input.owningDepartmentId ?? null,
      pledgedPaise: input.pledgedPaise,
      pledgedOn: input.pledgedOn ?? null,
      notes: input.notes ?? null,
      createdBy: actor.id,
    }).returning();

    // Event tickets and grants often arrive as money, not a promise; the tranche sets the status.

    for (const id of input.attachmentIds ?? []) await bindAttachment(tx, actor, id, row.id);

    await recordAudit(tx, {
      festId: actor.festId, entityType: "INCOME_ENTRY", entityId: row.id, actorId: actor.id,
      action: "income.create", after: snapshot(row, AUDITED),
    });
    return row;
  });
}

export async function updateIncome(actor: Actor, id: string, input: Partial<IncomeInput>) {
  assertCan(actor, "income.manage", { festId: actor.festId });
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);
    const [after] = await tx.update(incomeEntries).set({
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.sourceName !== undefined ? { sourceName: input.sourceName } : {}),
      ...(input.owningDepartmentId !== undefined ? { owningDepartmentId: input.owningDepartmentId } : {}),
      ...(input.pledgedPaise !== undefined ? { pledgedPaise: input.pledgedPaise } : {}),
      ...(input.pledgedOn !== undefined ? { pledgedOn: input.pledgedOn } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: new Date(),
    }).where(eq(incomeEntries.id, id)).returning();

    await refreshStatus(tx, id);
    await recordAudit(tx, {
      festId: actor.festId, entityType: "INCOME_ENTRY", entityId: id, actorId: actor.id,
      action: "income.update", before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
    });
    return after;
  });
}

export async function recordTranche(
  actor: Actor, id: string, input: { amountPaise: number; receivedOn: string; reference?: string | null },
) {
  assertCan(actor, "income.manage", { festId: actor.festId });
  if (input.amountPaise <= 0) throw new ApiError("VALIDATION_ERROR", "A tranche must be positive");

  return db.transaction(async (tx) => {
    const entry = await load(tx, actor, id);
    if (entry.status === "WRITTEN_OFF") {
      throw new ApiError("VALIDATION_ERROR", "Reinstate the pledge before recording money against it");
    }

    const [tranche] = await tx.insert(incomeTranches).values({
      incomeEntryId: id,
      amountPaise: input.amountPaise,
      receivedOn: input.receivedOn,
      reference: input.reference ?? null,
      recordedBy: actor.id,
    }).returning();

    const status = await refreshStatus(tx, id);
    await recordAudit(tx, {
      festId: actor.festId, entityType: "INCOME_ENTRY", entityId: id, actorId: actor.id,
      action: "income.tranche.record",
      after: { amount_paise: tranche.amountPaise, received_on: tranche.receivedOn, reference: tranche.reference, status },
    });
    return tranche;
  });
}

export async function transitionIncome(
  actor: Actor, id: string, action: "WRITE_OFF" | "REINSTATE", reason?: string,
) {
  assertCan(actor, "income.manage", { festId: actor.festId });
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);

    if (action === "WRITE_OFF") {
      if (before.status === "WRITTEN_OFF") throw new ApiError("INVALID_TRANSITION", "Already written off");
      if (!reason) throw new ApiError("VALIDATION_ERROR", "Writing off a pledge needs a reason");
      const [after] = await tx.update(incomeEntries)
        .set({ status: "WRITTEN_OFF", writtenOffReason: reason, updatedAt: new Date() })
        .where(eq(incomeEntries.id, id)).returning();
      await recordAudit(tx, {
        festId: actor.festId, entityType: "INCOME_ENTRY", entityId: id, actorId: actor.id,
        action: "income.transition.WRITE_OFF",
        before: snapshot(before, AUDITED), after: snapshot(after, AUDITED), reason,
      });
      return after;
    }

    if (before.status !== "WRITTEN_OFF") throw new ApiError("INVALID_TRANSITION", "Not written off");
    await tx.update(incomeEntries).set({ writtenOffReason: null, updatedAt: new Date() }).where(eq(incomeEntries.id, id));
    const status = await refreshStatus(tx, id);
    const [after] = await tx.select().from(incomeEntries).where(eq(incomeEntries.id, id));
    await recordAudit(tx, {
      festId: actor.festId, entityType: "INCOME_ENTRY", entityId: id, actorId: actor.id,
      action: "income.transition.REINSTATE",
      before: snapshot(before, AUDITED), after: { ...snapshot(after, AUDITED), status }, reason,
    });
    return after;
  });
}

/** Status is derived from the tranches, never typed in (7.4). */
async function refreshStatus(tx: Tx, id: string): Promise<string> {
  const [row] = (await tx.execute<{ status: string }>(sql`
    update income_entries e
       set status = case
             when e.status = 'WRITTEN_OFF' and e.written_off_reason is not null then 'WRITTEN_OFF'
             when t.received >= greatest(e.pledged_paise, 1) then 'RECEIVED'
             when t.received > 0 then 'PARTIALLY_RECEIVED'
             else 'PLEDGED'
           end::income_status,
           updated_at = now()
      from (select coalesce(sum(amount_paise), 0) as received
              from income_tranches where income_entry_id = ${id}) t
     where e.id = ${id}
     returning e.status
  `)) as unknown as { status: string }[];
  return row?.status ?? "PLEDGED";
}

async function load(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(incomeEntries)
    .where(and(eq(incomeEntries.id, id), eq(incomeEntries.festId, actor.festId), isNull(incomeEntries.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Income entry");
  return row;
}

async function bindAttachment(tx: Tx, actor: Actor, attachmentId: string, entryId: string) {
  const updated = await tx.update(attachments)
    .set({ entityType: "INCOME_ENTRY", entityId: entryId, purpose: "MOU" })
    .where(and(
      eq(attachments.id, attachmentId), eq(attachments.festId, actor.festId),
      eq(attachments.uploadedBy, actor.id), isNull(attachments.entityId),
    ))
    .returning({ id: attachments.id });
  if (updated.length === 0) throw new ApiError("VALIDATION_ERROR", `Attachment ${attachmentId} is not available to bind`);
}

/** The ledger: every entry with what it pledged, what arrived, and how long it has been waiting. */
export async function incomeLedger(actor: Actor, filters: { type?: string; status?: string; overdue?: boolean } = {}) {
  assertCan(actor, "income.view", { festId: actor.festId });
  const followupDays = await followupDaysFor(actor.festId);

  const rows = (await db.execute(sql`
    select e.id, e.type, e.source_name, e.pledged_paise, e.pledged_on, e.status, e.notes,
           e.written_off_reason, d.name as department,
           coalesce(t.received, 0) as received_paise,
           case when e.pledged_on is null then null
                else (current_date - e.pledged_on) end as days_since_pledge
      from income_entries e
      left join departments d on d.id = e.owning_department_id
      left join lateral (select coalesce(sum(amount_paise), 0) as received
                           from income_tranches where income_entry_id = e.id) t on true
     where e.fest_id = ${actor.festId} and e.deleted_at is null
       ${filters.type ? sql`and e.type = ${filters.type}::income_type` : sql``}
       ${filters.status ? sql`and e.status = ${filters.status}::income_status` : sql``}
       ${filters.overdue
         ? sql`and e.status in ('PLEDGED','PARTIALLY_RECEIVED')
               and e.pledged_on is not null
               and (current_date - e.pledged_on) > ${followupDays}`
         : sql``}
     order by e.type, e.source_name
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    type: String(r.type) as IncomeType,
    sourceName: String(r.source_name),
    department: (r.department as string) ?? null,
    pledgedPaise: Number(r.pledged_paise),
    receivedPaise: Number(r.received_paise),
    outstandingPaise: Math.max(Number(r.pledged_paise) - Number(r.received_paise), 0),
    pledgedOn: (r.pledged_on as string) ?? null,
    daysSincePledge: r.days_since_pledge === null ? null : Number(r.days_since_pledge),
    status: String(r.status),
    notes: (r.notes as string) ?? null,
    writtenOffReason: (r.written_off_reason as string) ?? null,
    // 7.4 — unreceived pledges past the follow-up window are highlighted.
    overdue: r.days_since_pledge !== null
      && Number(r.days_since_pledge) > followupDays
      && ["PLEDGED", "PARTIALLY_RECEIVED"].includes(String(r.status)),
  }));
}

export async function followupDaysFor(festId: string): Promise<number> {
  const [row] = (await db.execute<{ days: string }>(sql`
    select coalesce((settings->'flag_thresholds'->>'income_followup_days')::int, 30) as days
    from fests where id = ${festId}
  `)) as unknown as { days: string }[];
  return Number(row?.days ?? 30);
}

/** Sponsor-wise statement (12.5): the entry, its tranches, and who recorded each. */
export async function sponsorStatement(actor: Actor, id: string) {
  assertCan(actor, "income.view", { festId: actor.festId });
  const entry = await load(db as unknown as Tx, actor, id);
  const tranches = await db
    .select({
      id: incomeTranches.id, amountPaise: incomeTranches.amountPaise,
      receivedOn: incomeTranches.receivedOn, reference: incomeTranches.reference,
      recordedBy: users.name, createdAt: incomeTranches.createdAt,
    })
    .from(incomeTranches)
    .innerJoin(users, eq(users.id, incomeTranches.recordedBy))
    .where(eq(incomeTranches.incomeEntryId, id))
    .orderBy(desc(incomeTranches.receivedOn));

  const received = tranches.reduce((s, t) => s + t.amountPaise, 0);
  return {
    entry,
    tranches,
    receivedPaise: received,
    outstandingPaise: Math.max(entry.pledgedPaise - received, 0),
  };
}
