/**
 * The four dashboards (PRD 9, 20.11).
 *
 * Everything here is a read. The five numbers come from the views (18.2 rule 3),
 * and nothing is recomputed in JS — the arithmetic that matters lives in SQL and
 * has a fixture behind it (19.6).
 *
 * The shaping rule from section 9: each dashboard answers one question. The fest
 * overview answers "where do we stand?", the department one "how much have I got
 * left?", and the personal one "what is waiting on me?".
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ApiError } from "@/lib/api";
import { assertCan, can } from "@/lib/authz";
import { openFlagCounts } from "@/lib/services/flags";
import type { SessionUser } from "@/lib/session";
import {
  departmentTotals, departmentTotalsForFest, festTotals, incomeTotalsByType,
  lineItemTotalsForDepartment,
} from "./budget";
import { queueCounts } from "./queues";

/* ------------------------------------------------------------ fest overview */

export async function festDashboard(user: SessionUser) {
  assertCan(user, "income.view", { festId: user.festId }); // F and Mg (5.1)

  const [totals, departments, incomeByType, flags, queues, extras] = await Promise.all([
    festTotals(user.festId),
    departmentTotalsForFest(user.festId),
    incomeTotalsByType(user.festId),
    openFlagCounts(user),
    queueCounts(user),
    festExtras(user.festId),
  ]);

  if (!totals) throw new ApiError("NOT_FOUND", "No fest data yet");

  const names = await departmentNames(user.festId);

  return {
    totals,
    departments: departments.map((d) => ({ ...d, name: names.get(d.departmentId) ?? "—" })),
    income_by_type: incomeByType,
    flags,
    queues,
    ...extras,
  };
}

async function departmentNames(festId: string): Promise<Map<string, string>> {
  const rows = (await db.execute(sql`
    select id, name from departments where fest_id = ${festId} and is_active
  `)) as unknown as { id: string; name: string }[];
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** The things the overview shows that no view covers: what is late and what is stuck. */
async function festExtras(festId: string) {
  const [row] = (await db.execute(sql`
    select
      (select count(*)::int from vendor_requests vr
        where vr.fest_id = ${festId} and vr.deleted_at is null
          and vr.delivered_at is null and vr.expected_delivery_on is not null
          and vr.expected_delivery_on < current_date
          and vr.status not in ('CLOSED','DECLINED','CANCELLED','DRAFT'))       as overdue_vendors,
      (select count(*)::int from vendor_requests vr
        where vr.fest_id = ${festId} and vr.deleted_at is null
          and vr.status not in ('CLOSED','DECLINED','CANCELLED','DRAFT'))       as open_vendor_requests,
      (select count(*)::int from tickets t
        where t.fest_id = ${festId} and t.deleted_at is null
          and t.escalated_at is not null
          and t.status not in ('CLOSED','REJECTED','CANCELLED'))                as escalated_tickets,
      (select count(*)::int from tickets t
        where t.fest_id = ${festId} and t.deleted_at is null
          and t.due_at < now()
          and t.status not in ('CLOSED','REJECTED','CANCELLED'))                as overdue_tickets,
      (select count(*)::int from tickets t
        where t.fest_id = ${festId} and t.deleted_at is null and t.status = 'OPEN') as untriaged_tickets,
      (select count(*)::int from income_entries e
        where e.fest_id = ${festId} and e.deleted_at is null
          and e.status in ('PLEDGED','PARTIALLY_RECEIVED')
          and e.pledged_on is not null
          and (current_date - e.pledged_on)
              > coalesce((select (f.settings->'flag_thresholds'->>'income_followup_days')::int
                            from fests f where f.id = ${festId}), 30))          as overdue_pledges
  `)) as unknown as Record<string, number>[];

  return {
    overdue_vendors: Number(row?.overdue_vendors ?? 0),
    open_vendor_requests: Number(row?.open_vendor_requests ?? 0),
    escalated_tickets: Number(row?.escalated_tickets ?? 0),
    overdue_tickets: Number(row?.overdue_tickets ?? 0),
    untriaged_tickets: Number(row?.untriaged_tickets ?? 0),
    overdue_pledges: Number(row?.overdue_pledges ?? 0),
  };
}

/* ------------------------------------------------------ department dashboard */

export async function departmentDashboard(user: SessionUser, departmentId: string) {
  assertCan(user, "department.budget.view", { festId: user.festId, departmentId });

  const [meta] = (await db.execute(sql`
    select d.id, d.name, d.kind::text as kind,
           (select string_agg(u.name, ', ' order by u.name) from users u
             where u.department_id = d.id and u.role in ('DEPT_HOD','FINANCE_HOD') and u.status = 'ACTIVE') as hods
      from departments d
     where d.id = ${departmentId} and d.fest_id = ${user.festId}
  `)) as unknown as Record<string, string>[];
  if (!meta) throw new ApiError("NOT_FOUND", "Department not found");

  const [totals, lineItems, recent] = await Promise.all([
    departmentTotals(departmentId),
    lineItemTotalsForDepartment(departmentId),
    recentActivity(user.festId, departmentId),
  ]);

  const names = (await db.execute(sql`
    select li.id, li.name, li.status::text as status, li.reviewed_at,
           (select count(*)::int from attachments a
             where a.entity_type = 'LINE_ITEM' and a.entity_id = li.id and a.removed_at is null) as documents,
           (select count(*)::int from flags f
             where f.entity_type = 'LINE_ITEM' and f.entity_id = li.id and f.status = 'OPEN') as open_flags
      from line_items li
     where li.department_id = ${departmentId} and li.deleted_at is null
  `)) as unknown as Record<string, unknown>[];
  const meta_by_id = new Map(names.map((r) => [String(r.id), r]));

  return {
    department: { id: meta.id, name: meta.name, kind: meta.kind, hods: meta.hods ?? null },
    totals,
    line_items: lineItems.map((li) => ({
      ...li,
      name: String(meta_by_id.get(li.lineItemId)?.name ?? ""),
      reviewed_at: meta_by_id.get(li.lineItemId)?.reviewed_at ?? null,
      documents: Number(meta_by_id.get(li.lineItemId)?.documents ?? 0),
      open_flags: Number(meta_by_id.get(li.lineItemId)?.open_flags ?? 0),
    })),
    recent_activity: recent,
    tickets: await departmentTicketCounts(user.festId, departmentId),
  };
}

async function recentActivity(festId: string, departmentId: string) {
  return (await db.execute(sql`
    select r.id, r.human_id, r.description as title, r.status::text as status,
           r.amount_paise, r.updated_at, u.name as actor, 'REIMBURSEMENT' as kind
      from reimbursement_requests r
      join users u on u.id = r.submitter_id
     where r.fest_id = ${festId} and r.department_id = ${departmentId} and r.deleted_at is null
    union all
    select vr.id, vr.human_id, vr.description, vr.status::text,
           coalesce(vr.approved_value_paise, vr.total_value_paise), vr.updated_at,
           v.name, 'VENDOR_REQUEST'
      from vendor_requests vr
      join vendors v on v.id = vr.vendor_id
     where vr.fest_id = ${festId} and vr.department_id = ${departmentId} and vr.deleted_at is null
     order by updated_at desc
     limit 15
  `)) as unknown as Record<string, unknown>[];
}

async function departmentTicketCounts(festId: string, departmentId: string) {
  const [row] = (await db.execute(sql`
    select
      count(*) filter (where t.target_department_id = ${departmentId}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as inbox,
      count(*) filter (where t.target_department_id = ${departmentId}
                         and t.status = 'OPEN')::int                                 as untriaged,
      count(*) filter (where t.requesting_department_id = ${departmentId}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as outgoing,
      count(*) filter (where t.due_at < now()
                         and t.status not in ('CLOSED','REJECTED','CANCELLED')
                         and t.target_department_id = ${departmentId})::int          as overdue
      from tickets t
     where t.fest_id = ${festId} and t.deleted_at is null
  `)) as unknown as Record<string, number>[];
  return {
    inbox: Number(row?.inbox ?? 0), untriaged: Number(row?.untriaged ?? 0),
    outgoing: Number(row?.outgoing ?? 0), overdue: Number(row?.overdue ?? 0),
  };
}

/* -------------------------------------------------------- personal dashboard */

/** "What is waiting on me, and where did my requests get to?" (9, 20.11). */
export async function myDashboard(user: SessionUser) {
  const [requests] = (await db.execute(sql`
    select
      count(*) filter (where status = 'DRAFT')::int        as draft,
      count(*) filter (where status = 'SUBMITTED')::int    as submitted,
      count(*) filter (where status = 'HOD_ENDORSED')::int as endorsed,
      count(*) filter (where status = 'APPROVED')::int     as approved,
      count(*) filter (where status = 'ON_HOLD')::int      as on_hold,
      count(*) filter (where status = 'SENT_BACK')::int    as sent_back,
      count(*) filter (where status = 'PAID')::int         as paid,
      count(*) filter (where status = 'DECLINED')::int     as declined,
      coalesce(sum(amount_paise) filter (
        where status in ('SUBMITTED','HOD_ENDORSED','APPROVED','ON_HOLD')), 0)::bigint as awaiting_paise,
      coalesce(sum(amount_paise) filter (where status = 'PAID'), 0)::bigint            as paid_paise
      from reimbursement_requests
     where fest_id = ${user.festId} and submitter_id = ${user.id} and deleted_at is null
  `)) as unknown as Record<string, number>[];

  const [tickets] = (await db.execute(sql`
    select
      count(*) filter (where t.assignee_id = ${user.id}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as assigned_to_me,
      count(*) filter (where t.requester_id = ${user.id}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as raised_by_me,
      count(*) filter (where t.requester_id = ${user.id} and t.status = 'DONE')::int  as awaiting_my_confirmation,
      count(*) filter (where t.assignee_id = ${user.id} and t.due_at < now()
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as overdue
      from tickets t
     where t.fest_id = ${user.festId} and t.deleted_at is null
  `)) as unknown as Record<string, number>[];

  const [unread] = (await db.execute(sql`
    select count(*)::int as n from notifications
     where recipient_id = ${user.id} and channel = 'IN_APP' and read_at is null
  `)) as unknown as { n: number }[];

  const scope = { festId: user.festId, departmentId: user.departmentId };
  return {
    requests: Object.fromEntries(Object.entries(requests ?? {}).map(([k, v]) => [k, Number(v)])),
    tickets: Object.fromEntries(Object.entries(tickets ?? {}).map(([k, v]) => [k, Number(v)])),
    queues: await queueCounts(user),
    unread_notifications: Number(unread?.n ?? 0),
    department: can(user, "department.budget.view", scope)
      ? await departmentTotals(user.departmentId)
      : null,
  };
}
