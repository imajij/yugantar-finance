/**
 * The five numbers (PRD 6.2) and the fest roll-up (6.3), read from the views in
 * 0001_views.sql. 18.2 rule 3: never stored, never computed in JS.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";

export interface Totals {
  pendingPaise: number;
  committedPaise: number;
  spentPaise: number;
  availablePaise: number;
}

export interface LineItemTotals extends Totals {
  lineItemId: string;
  departmentId: string;
  status: "OPEN" | "CLOSED";
  plannedPaise: number;
}

export interface DepartmentTotals extends Totals {
  departmentId: string;
  kind: "BUDGET" | "FINANCE" | "CORE";
  allocatedPaise: number;
  plannedPaise: number;
}

export interface FestTotals extends Totals {
  festId: string;
  totalBudgetPaise: number;
  allocatedPaise: number;
  reservePaise: number;
  incomeReceivedPaise: number;
  incomePledgedPaise: number;
  incomeExpectedPaise: number;
  cashPositionPaise: number;
  projectedClosePaise: number;
}

/** Views return bigint as a string over the wire; paise are safe integers. */
const n = (v: unknown): number => Number(v ?? 0);

export async function lineItemTotals(lineItemId: string, tx: Tx | typeof db = db): Promise<LineItemTotals | null> {
  const rows = (await tx.execute(
    sql`select * from v_line_item_totals where line_item_id = ${lineItemId}`,
  )) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    lineItemId: String(r.line_item_id),
    departmentId: String(r.department_id),
    status: r.status as "OPEN" | "CLOSED",
    plannedPaise: n(r.planned_paise),
    pendingPaise: n(r.pending_paise),
    committedPaise: n(r.committed_paise),
    spentPaise: n(r.spent_paise),
    availablePaise: n(r.available_paise),
  };
}

export async function lineItemTotalsForDepartment(
  departmentId: string,
  tx: Tx | typeof db = db,
): Promise<LineItemTotals[]> {
  const rows = (await tx.execute(
    sql`select * from v_line_item_totals where department_id = ${departmentId}`,
  )) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    lineItemId: String(r.line_item_id),
    departmentId: String(r.department_id),
    status: r.status as "OPEN" | "CLOSED",
    plannedPaise: n(r.planned_paise),
    pendingPaise: n(r.pending_paise),
    committedPaise: n(r.committed_paise),
    spentPaise: n(r.spent_paise),
    availablePaise: n(r.available_paise),
  }));
}

/**
 * Every line item in the fest, for the people who may charge spend to any
 * department (Finance, Management — `lineItem.spendAgainst`).
 */
export async function lineItemTotalsForFest(
  festId: string,
  tx: Tx | typeof db = db,
): Promise<LineItemTotals[]> {
  const rows = (await tx.execute(sql`
    select v.* from v_line_item_totals v
      join line_items li on li.id = v.line_item_id
     where li.fest_id = ${festId}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    lineItemId: String(r.line_item_id),
    departmentId: String(r.department_id),
    status: r.status as "OPEN" | "CLOSED",
    plannedPaise: n(r.planned_paise),
    pendingPaise: n(r.pending_paise),
    committedPaise: n(r.committed_paise),
    spentPaise: n(r.spent_paise),
    availablePaise: n(r.available_paise),
  }));
}

export async function departmentTotals(departmentId: string, tx: Tx | typeof db = db): Promise<DepartmentTotals | null> {
  const rows = (await tx.execute(
    sql`select * from v_department_totals where department_id = ${departmentId}`,
  )) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return toDepartmentTotals(r);
}

export async function departmentTotalsForFest(festId: string, tx: Tx | typeof db = db): Promise<DepartmentTotals[]> {
  const rows = (await tx.execute(
    sql`select * from v_department_totals where fest_id = ${festId} order by allocated_paise desc`,
  )) as unknown as Record<string, unknown>[];
  return rows.map(toDepartmentTotals);
}

function toDepartmentTotals(r: Record<string, unknown>): DepartmentTotals {
  return {
    departmentId: String(r.department_id),
    kind: r.kind as DepartmentTotals["kind"],
    allocatedPaise: n(r.allocated_paise),
    plannedPaise: n(r.planned_paise),
    pendingPaise: n(r.pending_paise),
    committedPaise: n(r.committed_paise),
    spentPaise: n(r.spent_paise),
    availablePaise: n(r.available_paise),
  };
}

export async function festTotals(festId: string, tx: Tx | typeof db = db): Promise<FestTotals | null> {
  const rows = (await tx.execute(
    sql`select * from v_fest_totals where fest_id = ${festId}`,
  )) as unknown as Record<string, unknown>[];
  const r = rows[0];
  if (!r) return null;
  return {
    festId: String(r.fest_id),
    totalBudgetPaise: n(r.total_budget_paise),
    allocatedPaise: n(r.allocated_paise),
    reservePaise: n(r.reserve_paise),
    pendingPaise: n(r.pending_paise),
    committedPaise: n(r.committed_paise),
    spentPaise: n(r.spent_paise),
    availablePaise: n(r.total_budget_paise) - n(r.pending_paise) - n(r.committed_paise) - n(r.spent_paise),
    incomeReceivedPaise: n(r.income_received_paise),
    incomePledgedPaise: n(r.income_pledged_paise),
    incomeExpectedPaise: n(r.income_expected_paise),
    cashPositionPaise: n(r.cash_position_paise),
    projectedClosePaise: n(r.projected_close_paise),
  };
}

export interface IncomeTypeTotals {
  type: string;
  pledgedPaise: number;
  receivedPaise: number;
  expectedPaise: number;
}

export async function incomeTotalsByType(festId: string, tx: Tx | typeof db = db): Promise<IncomeTypeTotals[]> {
  const rows = (await tx.execute(
    sql`select * from v_income_totals where fest_id = ${festId} order by type`,
  )) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    type: String(r.type),
    pledgedPaise: n(r.pledged_paise),
    receivedPaise: n(r.received_paise),
    expectedPaise: n(r.expected_paise),
  }));
}
