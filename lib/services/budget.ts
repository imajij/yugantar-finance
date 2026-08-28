/**
 * Fest total, department allocations and reallocation (PRD 7.1, 7.5, 20.4).
 *
 * `departments.allocated_paise` is the current value; `budget_transfers` is the history.
 * The one hard block in the system lives here: Σ allocations may never exceed the fest total.
 */
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { budgetTransfers, departments, fests } from "@/db/schema";
import { assertCan, type Actor } from "@/lib/authz";
import { ApiError, notFound, overAllocation } from "@/lib/api";
import { departmentTotals } from "@/lib/queries/budget";
import { recordAudit } from "./audit";

/**
 * Takes the lock that everything touching the reserve queues behind, and returns
 * the fest total it is protecting.
 *
 * Σ allocations ≤ the fest total is a claim about many rows at once, so no column
 * constraint can hold it — it has to be a lock, and it has to be the same lock
 * everywhere. Both sides of the inequality live under this one: raising or lowering
 * the total, moving money out of the reserve, and creating a department that starts
 * with an allocation.
 */
export async function lockFestForAllocation(tx: Tx, festId: string) {
  const [fest] = await tx.select({ id: fests.id, totalBudgetPaise: fests.totalBudgetPaise })
    .from(fests).where(eq(fests.id, festId)).for("update");
  if (!fest) throw notFound("Fest");
  return fest;
}

export async function setTotalBudget(actor: Actor, totalBudgetPaise: number, reason: string) {
  assertCan(actor, "fest.manage", { festId: actor.festId });

  return db.transaction(async (tx) => {
    const fest = await lockFestForAllocation(tx, actor.festId);
    const allocated = await sumAllocations(tx, actor.festId);
    if (totalBudgetPaise < allocated) {
      throw overAllocation("The fest total cannot drop below what is already allocated", {
        allocated_paise: allocated, requested_paise: totalBudgetPaise,
      });
    }

    const [after] = await tx.update(fests)
      .set({ totalBudgetPaise, updatedAt: new Date() })
      .where(eq(fests.id, actor.festId)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "FEST", entityId: actor.festId, actorId: actor.id,
      action: "fest.total_budget.set",
      before: { total_budget_paise: fest.totalBudgetPaise },
      after: { total_budget_paise: after.totalBudgetPaise },
      reason,
    });
    return after;
  });
}

export interface TransferInput {
  /** null = the fest reserve. */
  fromDepartmentId: string | null;
  toDepartmentId: string | null;
  amountPaise: number;
  reason: string;
}

/**
 * Moves an allocation between two departments, or between a department and the reserve.
 * Both department rows are locked in a stable order so concurrent transfers cannot deadlock.
 */
export async function transferBudget(actor: Actor, input: TransferInput) {
  return db.transaction((tx) => transferBudgetIn(tx, actor, input));
}

/**
 * The transfer itself, on a caller's transaction.
 *
 * Approving an allocation request has to move the money and mark the request
 * decided atomically — two transactions would let a crash between them leave a
 * department richer with nothing on record saying why, or let two approvals of one
 * request both transfer. So the work lives here and `transferBudget` is the
 * single-purpose wrapper.
 */
export async function transferBudgetIn(tx: Tx, actor: Actor, input: TransferInput) {
  assertCan(actor, "budget.transfer", { festId: actor.festId });

  if (input.fromDepartmentId === input.toDepartmentId) {
    throw new ApiError("VALIDATION_ERROR", "A transfer needs two different endpoints");
  }
  if (input.amountPaise <= 0) {
    throw new ApiError("VALIDATION_ERROR", "Transfer amount must be positive");
  }

  /*
   * Anything that moves money *out of* the reserve serialises on the fest row.
   *
   * The department locks below are not enough, because two transfers into two
   * different departments never contend for the same department row. Each then
   * runs `sumAllocations` in READ COMMITTED, neither sees the other's uncommitted
   * increase, both find the reserve sufficient, and both commit — leaving Σ
   * allocations above the fest total, which is the one hard block in the system
   * (7.1). The reserve is a shared quantity, so it needs a shared lock, and the
   * fest row is the thing it is a property of.
   *
   * Taken before the department locks, and `setTotalBudget` takes the same row, so
   * every path that can change either side of the inequality queues in one order.
   * Moving money *back* into the reserve only ever helps the invariant and does not
   * need to wait.
   */
  if (input.fromDepartmentId === null) {
    await lockFestForAllocation(tx, actor.festId);
  }

  const ids = [input.fromDepartmentId, input.toDepartmentId].filter((x): x is string => x !== null).sort();
  const locked = new Map<string, { id: string; name: string; allocatedPaise: number }>();
  for (const id of ids) {
    const [row] = await tx
      .select({ id: departments.id, name: departments.name, allocatedPaise: departments.allocatedPaise, festId: departments.festId })
      .from(departments).where(eq(departments.id, id)).for("update");
    if (!row || row.festId !== actor.festId) throw notFound("Department");
    locked.set(id, row);
  }

  if (input.fromDepartmentId) {
    const from = locked.get(input.fromDepartmentId)!;
    const totals = await departmentTotals(from.id, tx);
    const floor = (totals?.committedPaise ?? 0) + (totals?.spentPaise ?? 0);
    const remaining = from.allocatedPaise - input.amountPaise;
    if (remaining < floor) {
      // 7.5 — an allocation may never drop below money already committed or spent.
      throw overAllocation(`${from.name} cannot go below its committed + spent`, {
        allocated_paise: from.allocatedPaise,
        committed_plus_spent_paise: floor,
        requested_transfer_paise: input.amountPaise,
      });
    }
    await tx.update(departments)
      .set({ allocatedPaise: remaining, updatedAt: new Date() })
      .where(eq(departments.id, from.id));
  }

  if (input.toDepartmentId) {
    const to = locked.get(input.toDepartmentId)!;
    await tx.update(departments)
      .set({ allocatedPaise: to.allocatedPaise + input.amountPaise, updatedAt: new Date() })
      .where(eq(departments.id, to.id));
  }

  // Moving out of reserve: check the reserve can cover it (the one hard block, 21.4).
  // Safe to read now: the fest row was locked above, so nothing else is allocating.
  if (input.fromDepartmentId === null) {
    const fest = await lockFestForAllocation(tx, actor.festId);
    const allocated = await sumAllocations(tx, actor.festId);
    if (allocated > fest.totalBudgetPaise) {
      throw overAllocation("The reserve does not cover this transfer", {
        total_budget_paise: fest.totalBudgetPaise,
        allocated_after_paise: allocated,
        reserve_before_paise: fest.totalBudgetPaise - (allocated - input.amountPaise),
      });
    }
  }

  const [row] = await tx.insert(budgetTransfers).values({
    festId: actor.festId,
    fromDepartmentId: input.fromDepartmentId,
    toDepartmentId: input.toDepartmentId,
    amountPaise: input.amountPaise,
    reason: input.reason,
    createdBy: actor.id,
  }).returning();

  await recordAudit(tx, {
    festId: actor.festId, entityType: "BUDGET_TRANSFER", entityId: row.id, actorId: actor.id,
    action: "budget.transfer",
    after: {
      from: input.fromDepartmentId ? locked.get(input.fromDepartmentId)!.name : "Reserve",
      to: input.toDepartmentId ? locked.get(input.toDepartmentId)!.name : "Reserve",
      amount_paise: input.amountPaise,
    },
    reason: input.reason,
  });
  return row;
}

async function sumAllocations(tx: Tx, festId: string): Promise<number> {
  const [{ total }] = (await tx.execute<{ total: string }>(sql`
    select coalesce(sum(allocated_paise), 0) as total
    from departments where fest_id = ${festId} and is_active
  `)) as unknown as { total: string }[];
  return Number(total);
}
