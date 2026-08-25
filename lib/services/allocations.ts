/**
 * Allocation requests (PRD 7.1, 7.5).
 *
 * A department head owns their budget's *shape* — the line items — but not its
 * *size*: an allocation only ever moves by transfer, with a reason, decided by the
 * money's custodian (5.2). That rule is worth keeping. What it did not have was a
 * way for the department to start the conversation, so allocations were negotiated
 * in a group chat and only the outcome was ever recorded.
 *
 * This is that conversation, as a record. The HOD states the total they need and
 * why; Finance or an administrator approves or declines with a note. Approval
 * performs the transfer itself, in the same transaction, and stores the transfer's
 * id — so the ask and the money are one trail rather than two.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { allocationRequests, departments } from "@/db/schema";
import { ApiError, notFound } from "@/lib/api";
import { assertCan, can, canFestWide, type Actor } from "@/lib/authz";
import { departmentTotals } from "@/lib/queries/budget";
import { formatPaise } from "@/lib/money";
import { recordAudit } from "./audit";
import { notify } from "./notifications";
import { transferBudgetIn } from "./budget";

const AUDIT_ENTITY = "ALLOCATION_REQUEST" as const;

export interface CreateAllocationRequestInput {
  departmentId: string;
  requestedPaise: number;
  reason: string;
}

export async function createAllocationRequest(actor: Actor, input: CreateAllocationRequestInput) {
  assertCan(actor, "allocationRequest.create", {
    festId: actor.festId, departmentId: input.departmentId,
  });
  if (input.requestedPaise < 0) {
    throw new ApiError("VALIDATION_ERROR", "An allocation cannot be negative");
  }
  if (input.reason.trim().length < 10) {
    throw new ApiError("VALIDATION_ERROR", "Say what the money is for — at least 10 characters");
  }

  return db.transaction(async (tx) => {
    const [dept] = await tx.select().from(departments)
      .where(eq(departments.id, input.departmentId)).for("update");
    // A UUID is not a secret (18.2 rule 10): the department has to be this fest's,
    // and `can()` cannot tell, because it only compares it to the actor's own.
    if (!dept || dept.festId !== actor.festId) throw notFound("Department");

    if (input.requestedPaise === dept.allocatedPaise) {
      throw new ApiError("VALIDATION_ERROR", "That is already the allocation");
    }

    // Asking for *less* than is already committed or spent cannot be granted, so it
    // is refused here rather than surviving as a request nobody can approve.
    if (input.requestedPaise < dept.allocatedPaise) {
      const totals = await departmentTotals(dept.id, tx);
      const floor = (totals?.committedPaise ?? 0) + (totals?.spentPaise ?? 0);
      if (input.requestedPaise < floor) {
        throw new ApiError(
          "VALIDATION_ERROR",
          `${dept.name} has already committed or spent ${formatPaise(floor)}, so its allocation cannot go below that`,
        );
      }
    }

    const [existing] = await tx.select({ id: allocationRequests.id }).from(allocationRequests)
      .where(and(
        eq(allocationRequests.departmentId, dept.id),
        eq(allocationRequests.status, "PENDING"),
      )).limit(1);
    if (existing) {
      throw new ApiError(
        "CONFLICT",
        "This department already has a request waiting on Finance. Withdraw it first to change what you are asking for.",
      );
    }

    const [row] = await tx.insert(allocationRequests).values({
      festId: actor.festId,
      departmentId: dept.id,
      requestedPaise: input.requestedPaise,
      currentPaise: dept.allocatedPaise,
      reason: input.reason.trim(),
      requestedBy: actor.id,
    }).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: AUDIT_ENTITY, entityId: row.id, actorId: actor.id,
      action: "allocation_request.create",
      after: {
        department: dept.name,
        current_paise: dept.allocatedPaise,
        requested_paise: input.requestedPaise,
      },
      reason: row.reason,
    });

    const delta = input.requestedPaise - dept.allocatedPaise;
    await notify(tx, {
      festId: actor.festId,
      type: "allocation_request.raised",
      title: `${dept.name} is asking for ${formatPaise(input.requestedPaise)}`,
      body: row.reason,
      entityType: "DEPARTMENT",
      entityId: dept.id,
      toRoles: ["FINANCE_HOD"],
      exceptUserId: actor.id,
      blocks: [
        { label: "Department", value: dept.name },
        { label: "Allocated now", value: formatPaise(dept.allocatedPaise) },
        { label: "Asking for", value: formatPaise(input.requestedPaise) },
        { label: delta > 0 ? "Increase" : "Decrease", value: formatPaise(Math.abs(delta)) },
      ],
    });

    return row;
  });
}

export async function withdrawAllocationRequest(actor: Actor, id: string) {
  return db.transaction(async (tx) => {
    const row = await loadPending(tx, actor, id);
    // Withdrawing is the requester's own act — an HOD taking back their ask. Anyone
    // else wanting it gone declines it, which leaves a note saying so.
    if (row.requestedBy !== actor.id) {
      assertCan(actor, "allocationRequest.create", { festId: actor.festId, departmentId: row.departmentId });
    }

    const [after] = await tx.update(allocationRequests)
      .set({ status: "WITHDRAWN", updatedAt: new Date() })
      .where(eq(allocationRequests.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: AUDIT_ENTITY, entityId: id, actorId: actor.id,
      action: "allocation_request.withdraw",
      before: { status: row.status }, after: { status: after.status },
    });
    return after;
  });
}

export type AllocationDecision = "APPROVE" | "DECLINE";

/**
 * Approving does the transfer. Declining does not.
 *
 * The transfer runs through `transferBudgetIn` rather than writing
 * `departments.allocated_paise` here, so every guard it enforces still applies at
 * the moment of approval and not at the moment of asking: the reserve has to cover
 * an increase, and a decrease may not drop the department below its committed +
 * spent. A request raised on Monday can therefore be refused by the arithmetic on
 * Friday, which is correct — the money moved in between.
 */
export async function decideAllocationRequest(
  actor: Actor, id: string, decision: AllocationDecision, note: string,
) {
  assertCan(actor, "allocationRequest.decide", { festId: actor.festId });
  if (!note?.trim()) {
    throw new ApiError("VALIDATION_ERROR", "A note is required either way — it is what the department reads");
  }

  return db.transaction(async (tx) => {
    // Locked before anything is read off it: two administrators clicking approve at
    // once must not both transfer. The second waits, then finds it already decided.
    const row = await loadPending(tx, actor, id);
    const [dept] = await tx.select().from(departments).where(eq(departments.id, row.departmentId));

    let transferId: string | null = null;
    if (decision === "APPROVE") {
      const delta = row.requestedPaise - dept.allocatedPaise;
      if (delta !== 0) {
        // Positive: out of Reserve into the department. Negative: back again.
        const transfer = await transferBudgetIn(tx, actor, {
          fromDepartmentId: delta > 0 ? null : dept.id,
          toDepartmentId: delta > 0 ? dept.id : null,
          amountPaise: Math.abs(delta),
          reason: `Allocation request: ${row.reason}`,
        });
        transferId = transfer.id;
      }
    }

    const [after] = await tx.update(allocationRequests).set({
      status: decision === "APPROVE" ? "APPROVED" : "DECLINED",
      decidedBy: actor.id,
      decidedAt: new Date(),
      decisionNote: note.trim(),
      transferId,
      updatedAt: new Date(),
    }).where(eq(allocationRequests.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: AUDIT_ENTITY, entityId: id, actorId: actor.id,
      action: `allocation_request.${decision.toLowerCase()}`,
      before: { status: "PENDING", requested_paise: row.requestedPaise },
      after: { status: after.status, transfer_id: transferId },
      reason: note.trim(),
    });

    await notify(tx, {
      festId: actor.festId,
      type: `allocation_request.${decision.toLowerCase()}`,
      title:
        decision === "APPROVE"
          ? `${dept.name} is now allocated ${formatPaise(row.requestedPaise)}`
          : `Your allocation request for ${dept.name} was declined`,
      body: note.trim(),
      entityType: "DEPARTMENT",
      entityId: dept.id,
      toUsers: [row.requestedBy],
      toDepartmentHods: [dept.id],
      exceptUserId: actor.id,
      blocks: [
        { label: "Department", value: dept.name },
        { label: "Asked for", value: formatPaise(row.requestedPaise) },
        { label: "Decision", value: decision === "APPROVE" ? "Approved" : "Declined" },
      ],
    });

    return after;
  });
}

export interface AllocationRequestFilters {
  status?: "PENDING" | "APPROVED" | "DECLINED" | "WITHDRAWN";
  departmentId?: string;
  limit?: number;
}

/** Finance and administrators see the whole queue; an HOD sees their own department. */
export async function listAllocationRequests(actor: Actor, filters: AllocationRequestFilters = {}) {
  assertCan(actor, "allocationRequest.view", {
    festId: actor.festId, departmentId: filters.departmentId ?? actor.departmentId,
  });
  const festWide = canFestWide(actor, "allocationRequest.view");
  const scoped = festWide ? filters.departmentId : actor.departmentId;

  return (await db.execute(sql`
    select ar.id, ar.status::text as status, ar.requested_paise, ar.current_paise,
           ar.reason, ar.decision_note, ar.decided_at, ar.created_at,
           ar.department_id, d.name as department_name, d.allocated_paise as allocated_now,
           ru.name as requested_by_name, du.name as decided_by_name
      from allocation_requests ar
      join departments d on d.id = ar.department_id
      join users ru on ru.id = ar.requested_by
      left join users du on du.id = ar.decided_by
     where ar.fest_id = ${actor.festId}
       ${filters.status ? sql`and ar.status = ${filters.status}::allocation_request_status` : sql``}
       ${scoped ? sql`and ar.department_id = ${scoped}` : sql``}
     order by (ar.status = 'PENDING') desc, ar.created_at desc
     limit ${filters.limit ?? 100}
  `)) as unknown as Record<string, unknown>[];
}

/** The one open ask for a department, for the budget screen. */
export async function pendingFor(actor: Actor, departmentId: string) {
  if (!can(actor, "allocationRequest.view", { festId: actor.festId, departmentId })) return null;
  const [row] = await db.select().from(allocationRequests)
    .where(and(
      eq(allocationRequests.festId, actor.festId),
      eq(allocationRequests.departmentId, departmentId),
      eq(allocationRequests.status, "PENDING"),
    ))
    .orderBy(desc(allocationRequests.createdAt))
    .limit(1);
  return row ?? null;
}

/** How many asks are waiting on a decision — the badge on the budget screen. */
export async function pendingAllocationCount(actor: Actor): Promise<number> {
  if (!can(actor, "allocationRequest.decide", { festId: actor.festId })) return 0;
  const [{ n }] = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from allocation_requests
     where fest_id = ${actor.festId} and status = 'PENDING'
  `)) as unknown as { n: number }[];
  return Number(n);
}

async function loadPending(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(allocationRequests)
    .where(and(eq(allocationRequests.id, id), eq(allocationRequests.festId, actor.festId)))
    .for("update");
  if (!row) throw notFound("Allocation request");
  if (row.status !== "PENDING") {
    throw new ApiError("INVALID_TRANSITION", `That request is already ${row.status.toLowerCase()}`);
  }
  return row;
}
