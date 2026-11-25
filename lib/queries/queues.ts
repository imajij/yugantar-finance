/**
 * The three decision queues (PRD 20.11).
 *
 * A queue is "what is waiting on *you*", and the ordering is the whole point:
 * flagged first, then oldest first. A request that has been sitting for a week
 * outranks one raised this morning, and anything carrying a High flag outranks
 * both — that is what keeps the 8.3 flags from becoming decoration.
 *
 * Approvals and payments deliberately mix reimbursements and vendor milestones:
 * Finance approves both, Management pays both, and splitting them across two
 * screens is how a vendor balance gets forgotten (success metric in section 16).
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { assertCan, can, maskAccountNumber } from "@/lib/authz";
import type { SessionUser } from "@/lib/session";
import { OWED_ON_MILESTONE, PAYABLE_MILESTONE } from "./vendor-payable";

export interface QueueFlag {
  rule: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  explanation: string;
}

export interface QueueItem {
  kind: "REIMBURSEMENT" | "VENDOR_REQUEST";
  id: string;
  human_id: string;
  status: string;
  title: string;
  department: string;
  department_id: string;
  line_item: string | null;
  amount_paise: number;
  payee_name: string;
  payee_upi_id: string | null;
  payee_bank_account: string | null;
  payee_bank_ifsc: string | null;
  submitter: string;
  submitter_id: string;
  waiting_since: Date;
  age_days: number;
  flags: QueueFlag[];
  high_flags: number;
  /** What approving would leave in the line item — the number an HOD actually needs. */
  line_item_available_paise: number | null;
  /** Which milestone a payment would settle. */
  milestone_id?: string;
  milestone_kind?: string;
}

/** Flagged first, then oldest. Written once, used by all three queues. */
const QUEUE_ORDER = sql`high_flags desc, flag_count desc, waiting_since asc`;

const FLAGS_FOR = (entityType: string, idColumn: string) => sql`
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'rule', f.rule, 'severity', f.severity, 'explanation', f.explanation)
           order by case f.severity when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end)
      from flags f
     where f.entity_type = ${entityType} and f.entity_id = ${sql.raw(idColumn)} and f.status = 'OPEN'
  ), '[]'::jsonb)
`;

const COUNT_FLAGS = (entityType: string, idColumn: string, severity?: string) => sql`
  (select count(*)::int from flags f
    where f.entity_type = ${entityType} and f.entity_id = ${sql.raw(idColumn)}
      and f.status = 'OPEN' ${severity ? sql`and f.severity = ${severity}` : sql``})
`;

function shape(row: Record<string, unknown>, user: SessionUser): QueueItem {
  const seesBank = can(user, "vendor.bankDetails.view", { festId: user.festId });
  const account = (row.payee_bank_account as string | null) ?? null;
  return {
    kind: row.kind as QueueItem["kind"],
    id: String(row.id),
    human_id: String(row.human_id),
    status: String(row.status),
    title: String(row.title),
    department: String(row.department),
    department_id: String(row.department_id),
    line_item: (row.line_item as string) ?? null,
    amount_paise: Number(row.amount_paise ?? 0),
    payee_name: String(row.payee_name ?? ""),
    payee_upi_id: (row.payee_upi_id as string) ?? null,
    payee_bank_account: seesBank ? account : maskAccountNumber(account),
    payee_bank_ifsc: (row.payee_bank_ifsc as string) ?? null,
    submitter: String(row.submitter ?? ""),
    submitter_id: String(row.submitter_id ?? ""),
    waiting_since: row.waiting_since as Date,
    age_days: Math.floor(Number(row.age_days ?? 0)),
    flags: (row.flags as QueueFlag[]) ?? [],
    high_flags: Number(row.high_flags ?? 0),
    line_item_available_paise: row.line_item_available_paise === null || row.line_item_available_paise === undefined
      ? null : Number(row.line_item_available_paise),
    milestone_id: (row.milestone_id as string) ?? undefined,
    milestone_kind: (row.milestone_kind as string) ?? undefined,
  };
}

/**
 * The Dept HOD's queue: SUBMITTED requests from their own department, with the
 * effect on Available spelled out so the decision does not need a second screen.
 * A HOD never endorses their own request (5.2), so their own are filtered out.
 */
export async function endorsementQueue(user: SessionUser): Promise<QueueItem[]> {
  assertCan(user, "reimbursement.endorse", {
    festId: user.festId, departmentId: user.departmentId, submitterId: "-",
  });

  const rows = (await db.execute(sql`
    select 'REIMBURSEMENT' as kind, r.id, r.human_id, r.status::text as status,
           r.description as title, d.name as department, r.department_id,
           li.name as line_item, r.amount_paise,
           r.payee_name, r.payee_upi_id, null::text as payee_bank_account, null::text as payee_ifsc,
           u.name as submitter, r.submitter_id,
           coalesce(r.submitted_at, r.created_at) as waiting_since,
           extract(epoch from now() - coalesce(r.submitted_at, r.created_at)) / 86400 as age_days,
           ${FLAGS_FOR("REIMBURSEMENT", "r.id")} as flags,
           ${COUNT_FLAGS("REIMBURSEMENT", "r.id", "HIGH")} as high_flags,
           ${COUNT_FLAGS("REIMBURSEMENT", "r.id")} as flag_count,
           v.available_paise as line_item_available_paise,
           null::uuid as milestone_id, null::text as milestone_kind
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
      join users u on u.id = r.submitter_id
      left join v_line_item_totals v on v.line_item_id = r.line_item_id
     where r.fest_id = ${user.festId} and r.deleted_at is null
       and r.status = 'SUBMITTED'
       and r.department_id = ${user.departmentId}
       and r.submitter_id <> ${user.id}
     order by ${QUEUE_ORDER}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => shape(r, user));
}

/**
 * Finance's queue (20.11): endorsed reimbursements, submitted vendor requests, and
 * delivered vendor requests whose balance still needs releasing.
 */
export async function approvalQueue(user: SessionUser): Promise<QueueItem[]> {
  assertCan(user, "vendorRequest.approve", { festId: user.festId, submitterId: "-" });

  const rows = (await db.execute(sql`
    select 'REIMBURSEMENT' as kind, r.id, r.human_id, r.status::text as status,
           r.description as title, d.name as department, r.department_id,
           li.name as line_item, r.amount_paise,
           r.payee_name, r.payee_upi_id, null::text as payee_bank_account, null::text as payee_ifsc,
           u.name as submitter, r.submitter_id,
           coalesce(r.endorsed_at, r.submitted_at, r.created_at) as waiting_since,
           extract(epoch from now() - coalesce(r.endorsed_at, r.submitted_at, r.created_at)) / 86400 as age_days,
           ${FLAGS_FOR("REIMBURSEMENT", "r.id")} as flags,
           ${COUNT_FLAGS("REIMBURSEMENT", "r.id", "HIGH")} as high_flags,
           ${COUNT_FLAGS("REIMBURSEMENT", "r.id")} as flag_count,
           v.available_paise as line_item_available_paise,
           null::uuid as milestone_id, null::text as milestone_kind
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
      join users u on u.id = r.submitter_id
      left join v_line_item_totals v on v.line_item_id = r.line_item_id
     where r.fest_id = ${user.festId} and r.deleted_at is null
       and r.status = 'HOD_ENDORSED'
       and r.submitter_id <> ${user.id}

    union all

    select 'VENDOR_REQUEST' as kind, vr.id, vr.human_id, vr.status::text,
           vr.description, d.name, vr.department_id,
           li.name, coalesce(vr.approved_value_paise, vr.total_value_paise),
           ven.name, ven.upi_id, ven.bank_account_number, ven.bank_ifsc,
           u.name, vr.requested_by,
           coalesce(vr.delivered_at, vr.created_at),
           extract(epoch from now() - coalesce(vr.delivered_at, vr.created_at)) / 86400,
           ${FLAGS_FOR("VENDOR_REQUEST", "vr.id")},
           ${COUNT_FLAGS("VENDOR_REQUEST", "vr.id", "HIGH")},
           ${COUNT_FLAGS("VENDOR_REQUEST", "vr.id")},
           v2.available_paise,
           null::uuid, null::text
      from vendor_requests vr
      join departments d on d.id = vr.department_id
      join line_items li on li.id = vr.line_item_id
      join vendors ven on ven.id = vr.vendor_id
      join users u on u.id = vr.requested_by
      left join v_line_item_totals v2 on v2.line_item_id = vr.line_item_id
     where vr.fest_id = ${user.festId} and vr.deleted_at is null
       and vr.status in ('SUBMITTED', 'DELIVERED')
       -- Including the Finance HOD's own: they approve those too, with a note (5.2).

     order by ${QUEUE_ORDER}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => shape(r, user));
}

/**
 * Management's queue (20.11): approved reimbursements and payable vendor milestones,
 * with the payee details needed to actually make the transfer. Grouping by payee is
 * done by the caller — the shape here stays one row per payable thing.
 */
export async function paymentQueue(user: SessionUser): Promise<QueueItem[]> {
  assertCan(user, "reimbursement.recordPayment", { festId: user.festId, submitterId: "-" });

  const rows = (await db.execute(sql`
    select 'REIMBURSEMENT' as kind, r.id, r.human_id, r.status::text as status,
           r.description as title, d.name as department, r.department_id,
           li.name as line_item, r.amount_paise,
           r.payee_name, r.payee_upi_id, null::text as payee_bank_account, null::text as payee_ifsc,
           u.name as submitter, r.submitter_id,
           coalesce(r.approved_at, r.created_at) as waiting_since,
           extract(epoch from now() - coalesce(r.approved_at, r.created_at)) / 86400 as age_days,
           ${FLAGS_FOR("REIMBURSEMENT", "r.id")} as flags,
           ${COUNT_FLAGS("REIMBURSEMENT", "r.id", "HIGH")} as high_flags,
           ${COUNT_FLAGS("REIMBURSEMENT", "r.id")} as flag_count,
           null::bigint as line_item_available_paise,
           null::uuid as milestone_id, null::text as milestone_kind
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
      join users u on u.id = r.submitter_id
     where r.fest_id = ${user.festId} and r.deleted_at is null
       and r.status = 'APPROVED'
       -- 5.2: Management never pays their own claim.
       and r.submitter_id <> ${user.id}

    union all

    -- An advance becomes payable on approval; a balance only once it is released;
    -- the rest of a part-paid milestone at any stage. See PAYABLE_MILESTONE.
    select 'VENDOR_REQUEST' as kind, vr.id, vr.human_id, vr.status::text,
           vr.description, d.name, vr.department_id,
           li.name, ${OWED_ON_MILESTONE},
           ven.name, ven.upi_id, ven.bank_account_number, ven.bank_ifsc,
           u.name, vr.requested_by,
           coalesce(vr.balance_approved_at, vr.approved_at, vr.created_at),
           extract(epoch from now() - coalesce(vr.balance_approved_at, vr.approved_at, vr.created_at)) / 86400,
           ${FLAGS_FOR("VENDOR_REQUEST", "vr.id")},
           ${COUNT_FLAGS("VENDOR_REQUEST", "vr.id", "HIGH")},
           ${COUNT_FLAGS("VENDOR_REQUEST", "vr.id")},
           null::bigint,
           m.id, m.kind::text
      from vendor_requests vr
      join vendor_milestones m on m.vendor_request_id = vr.id
      join departments d on d.id = vr.department_id
      join line_items li on li.id = vr.line_item_id
      join vendors ven on ven.id = vr.vendor_id
      join users u on u.id = vr.requested_by
     where vr.fest_id = ${user.festId} and vr.deleted_at is null
       and ${PAYABLE_MILESTONE}

     order by ${QUEUE_ORDER}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => shape(r, user));
}

/** 12.3 / 20.11 — the payment queue as Management works it: one block per payee. */
export interface PayeeGroup {
  payee_name: string;
  payee_upi_id: string | null;
  payee_bank_account: string | null;
  payee_bank_ifsc: string | null;
  total_paise: number;
  items: QueueItem[];
}

export function groupByPayee(items: QueueItem[]): PayeeGroup[] {
  const groups = new Map<string, PayeeGroup>();
  for (const item of items) {
    // Same name, same account is the same person to pay. UPI is the usual key;
    // vendors paid by transfer are keyed on the account instead.
    const key = `${item.payee_name}|${item.payee_upi_id ?? item.payee_bank_account ?? ""}`;
    const group = groups.get(key) ?? {
      payee_name: item.payee_name,
      payee_upi_id: item.payee_upi_id,
      payee_bank_account: item.payee_bank_account,
      payee_bank_ifsc: item.payee_bank_ifsc,
      total_paise: 0,
      items: [],
    };
    group.total_paise += item.amount_paise;
    group.items.push(item);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.total_paise - a.total_paise);
}

/** Counts for the dashboards and the sidebar, without loading the queues themselves. */
export async function queueCounts(user: SessionUser): Promise<{ endorsements: number; approvals: number; payments: number }> {
  const [row] = (await db.execute(sql`
    select
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = ${user.festId} and r.deleted_at is null
          and r.status = 'SUBMITTED' and r.department_id = ${user.departmentId}
          and r.submitter_id <> ${user.id}) as endorsements,
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = ${user.festId} and r.deleted_at is null
          and r.status = 'HOD_ENDORSED' and r.submitter_id <> ${user.id})
      + (select count(*)::int from vendor_requests vr
        where vr.fest_id = ${user.festId} and vr.deleted_at is null
          and vr.status in ('SUBMITTED','DELIVERED')) as approvals,
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = ${user.festId} and r.deleted_at is null
          and r.status = 'APPROVED' and r.submitter_id <> ${user.id})
      + (select count(*)::int from vendor_milestones m
          join vendor_requests vr on vr.id = m.vendor_request_id
        where vr.fest_id = ${user.festId} and vr.deleted_at is null
          and ${PAYABLE_MILESTONE}) as payments
  `)) as unknown as Record<string, number>[];

  const scope = { festId: user.festId, departmentId: user.departmentId, submitterId: "-" };
  return {
    endorsements: can(user, "reimbursement.endorse", scope) ? Number(row?.endorsements ?? 0) : 0,
    approvals: can(user, "vendorRequest.approve", scope) ? Number(row?.approvals ?? 0) : 0,
    payments: can(user, "reimbursement.recordPayment", scope) ? Number(row?.payments ?? 0) : 0,
  };
}
