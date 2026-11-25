/**
 * The Department expenses section (PRD 9, Finance HOD): every department the
 * Finance HOD can add spend to, and what they have already added for departments
 * other than their own.
 *
 * Reads only. Available comes from `v_department_totals` (18.2 rule 3), and both
 * queries are scoped by the caller's fest (rule 10).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assertCan, type Actor } from "@/lib/authz";

export interface ExpenseDepartment {
  id: string;
  name: string;
  availablePaise: number;
  openLineItems: number;
}

export interface AddedExpense {
  kind: "REIMBURSEMENT" | "VENDOR_REQUEST";
  id: string;
  humanId: string;
  description: string;
  department: string;
  amountPaise: number;
  status: string;
  createdAt: Date;
}

export async function departmentsForExpenses(actor: Actor): Promise<ExpenseDepartment[]> {
  assertCan(actor, "expense.forAnyDepartment", { festId: actor.festId });
  const rows = (await db.execute(sql`
    select d.id, d.name,
           coalesce(v.available_paise, 0) as available_paise,
           (select count(*)::int from line_items li
             where li.department_id = d.id and li.status = 'OPEN' and li.deleted_at is null) as open_line_items
      from departments d
      left join v_department_totals v on v.department_id = d.id
     where d.fest_id = ${actor.festId} and d.is_active
       and d.id <> ${actor.departmentId}
     order by d.name
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    availablePaise: Number(r.available_paise),
    openLineItems: Number(r.open_line_items),
  }));
}

/** What this person raised against departments other than their own, newest first. */
export async function expensesAddedForOthers(actor: Actor, limit = 30): Promise<AddedExpense[]> {
  assertCan(actor, "expense.forAnyDepartment", { festId: actor.festId });
  const rows = (await db.execute(sql`
    select * from (
      select 'REIMBURSEMENT' as kind, r.id, r.human_id, r.description, d.name as department,
             r.amount_paise as amount_paise, r.status::text as status, r.created_at
        from reimbursement_requests r
        join departments d on d.id = r.department_id
       where r.fest_id = ${actor.festId} and r.deleted_at is null
         and r.submitter_id = ${actor.id} and r.department_id <> ${actor.departmentId}
      union all
      select 'VENDOR_REQUEST', vr.id, vr.human_id, vr.description, d.name,
             coalesce(vr.approved_value_paise, vr.total_value_paise), vr.status::text, vr.created_at
        from vendor_requests vr
        join departments d on d.id = vr.department_id
       where vr.fest_id = ${actor.festId} and vr.deleted_at is null
         and vr.requested_by = ${actor.id} and vr.department_id <> ${actor.departmentId}
    ) x
    order by created_at desc
    limit ${limit}
  `)) as unknown as Record<string, unknown>[];
  return rows.map((r) => ({
    kind: r.kind as AddedExpense["kind"],
    id: String(r.id),
    humanId: String(r.human_id),
    description: String(r.description),
    department: String(r.department),
    amountPaise: Number(r.amount_paise),
    status: String(r.status),
    createdAt: new Date(r.created_at as string),
  }));
}
