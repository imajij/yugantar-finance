/**
 * CSV exports (PRD 12). These are what the committee hands the accounts office at
 * close-out, so every row carries the human ID and the department it belongs to.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assertCan, type Actor } from "@/lib/authz";

export type ExportKind =
  | "reimbursements" | "vendor-payments" | "income" | "line-items" | "tickets" | "audit";

/** RFC 4180 quoting — a description with a comma must not shift every later column. */
export function csv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ].join("\r\n");
}

/** Paise are rendered as rupees with two decimals — accounts software expects that. */
const RUPEES = (col: string) => sql.raw(`round(${col}::numeric / 100, 2)`);

const QUERIES: Record<ExportKind, (festId: string) => ReturnType<typeof db.execute>> = {
  reimbursements: (festId) => db.execute(sql`
    select r.human_id, d.name as department, li.name as line_item, et.name as expense_type,
           r.description, r.transaction_on, ${RUPEES("r.amount_paise")} as amount_rupees,
           r.status, u.name as submitted_by, r.payee_name, r.payee_upi_id,
           eu.name as endorsed_by, r.endorsed_at,
           au.name as approved_by, r.approved_at,
           pu.name as paid_by, r.paid_at, r.payment_reference,
           (select count(*) from flags f
             where f.entity_type = 'REIMBURSEMENT' and f.entity_id = r.id and f.status = 'OPEN') as open_flags
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
      join expense_types et on et.id = r.expense_type_id
      join users u on u.id = r.submitter_id
      left join users eu on eu.id = r.endorsed_by
      left join users au on au.id = r.approved_by
      left join users pu on pu.id = r.paid_by
     where r.fest_id = ${festId} and r.deleted_at is null
     order by r.human_id
  `),

  "vendor-payments": (festId) => db.execute(sql`
    select vr.human_id, v.name as vendor, d.name as department, li.name as line_item,
           vr.description, vr.status,
           ${RUPEES("vr.total_value_paise")} as requested_rupees,
           ${RUPEES("coalesce(vr.approved_value_paise, vr.total_value_paise)")} as approved_rupees,
           ${RUPEES("coalesce(m.paid, 0)")} as paid_rupees,
           ${RUPEES("coalesce(vr.approved_value_paise, vr.total_value_paise) - coalesce(m.paid, 0)")} as outstanding_rupees,
           vr.expected_delivery_on, vr.delivered_at,
           ${RUPEES("vr.refund_expected_paise")} as refund_expected_rupees,
           ${RUPEES("vr.refund_received_paise")} as refund_received_rupees,
           m.refs as payment_references
      from vendor_requests vr
      join vendors v on v.id = vr.vendor_id
      join departments d on d.id = vr.department_id
      join line_items li on li.id = vr.line_item_id
      left join lateral (
        select sum(paid_paise) as paid, string_agg(payment_reference, ' | ') as refs
          from vendor_milestones where vendor_request_id = vr.id
      ) m on true
     where vr.fest_id = ${festId} and vr.deleted_at is null
     order by vr.human_id
  `),

  income: (festId) => db.execute(sql`
    select e.type, e.source_name, d.name as owning_department, e.status,
           ${RUPEES("e.pledged_paise")} as pledged_rupees,
           ${RUPEES("coalesce(t.received, 0)")} as received_rupees,
           ${RUPEES("greatest(e.pledged_paise - coalesce(t.received, 0), 0)")} as outstanding_rupees,
           e.pledged_on, t.last_received_on, t.refs as references,
           e.written_off_reason,
           (e.type <> 'SPONSORSHIP_IN_KIND') as counts_toward_cash
      from income_entries e
      left join departments d on d.id = e.owning_department_id
      left join lateral (
        select sum(amount_paise) as received, max(received_on) as last_received_on,
               string_agg(reference, ' | ') as refs
          from income_tranches where income_entry_id = e.id
      ) t on true
     where e.fest_id = ${festId} and e.deleted_at is null
     order by e.type, e.source_name
  `),

  // The five numbers, straight from the view — the sheet that has to reconcile.
  "line-items": (festId) => db.execute(sql`
    select d.name as department, li.name as line_item, li.status,
           ${RUPEES("v.planned_paise")} as planned_rupees,
           ${RUPEES("v.pending_paise")} as pending_rupees,
           ${RUPEES("v.committed_paise")} as committed_rupees,
           ${RUPEES("v.spent_paise")} as spent_rupees,
           ${RUPEES("v.available_paise")} as available_rupees,
           li.reviewed_at, li.close_reason
      from v_line_item_totals v
      join line_items li on li.id = v.line_item_id
      join departments d on d.id = li.department_id
     where li.fest_id = ${festId} and li.deleted_at is null
     order by d.name, li.name
  `),

  tickets: (festId) => db.execute(sql`
    select t.human_id, t.title, rq.name as requesting_department, tg.name as target_department,
           ru.name as requester, au.name as assignee, t.priority, t.status,
           t.due_at, t.created_at, t.triaged_at, t.started_at, t.done_at, t.closed_at,
           (t.due_at < coalesce(t.done_at, now())) as missed_deadline,
           t.location, ${RUPEES("t.estimated_cost_paise")} as estimated_cost_rupees,
           t.escalated_at is not null as escalated
      from tickets t
      join departments rq on rq.id = t.requesting_department_id
      join departments tg on tg.id = t.target_department_id
      join users ru on ru.id = t.requester_id
      left join users au on au.id = t.assignee_id
     where t.fest_id = ${festId} and t.deleted_at is null
     order by t.human_id
  `),

  audit: (festId) => db.execute(sql`
    select a.created_at, u.name as actor, a.entity_type, a.entity_id, a.action, a.reason,
           a.before::text as before_json, a.after::text as after_json
      from audit_events a
      left join users u on u.id = a.actor_id
     where a.fest_id = ${festId}
     order by a.created_at
  `),
};

const PERMISSION: Record<ExportKind, Parameters<typeof assertCan>[1]> = {
  reimbursements: "export.run",
  "vendor-payments": "export.run",
  income: "export.run",
  "line-items": "export.run",
  tickets: "export.run",
  audit: "audit.view",
};

export async function runExport(actor: Actor, kind: ExportKind): Promise<string> {
  assertCan(actor, PERMISSION[kind], { festId: actor.festId });
  const rows = (await QUERIES[kind](actor.festId)) as unknown as Record<string, unknown>[];
  return csv(rows);
}

export const EXPORT_KINDS = Object.keys(QUERIES) as ExportKind[];
