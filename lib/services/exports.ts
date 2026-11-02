/**
 * The seven exports of PRD 12, in CSV and XLSX.
 *
 * These are what the committee hands the accounts office at close-out, so three
 * things hold for every one of them:
 *   - Every row carries the human ID and the department it belongs to. A row
 *     nobody can trace back is worse than no row.
 *   - Amounts are real numbers in XLSX (see `lib/xlsx.ts`), and plain decimals in
 *     CSV. Never a formatted string that has to be retyped.
 *   - The five numbers come from the views (18.2 rule 3), never re-derived here.
 *
 * Section 12 says every export is filterable by date range, department, state,
 * line item, expense type, vendor and payee; `Filters` below is that list, and
 * each query applies the subset that makes sense for it.
 *
 * The statement-style exports (12.2, 12.5 sponsor, 12.6) also render as a
 * print-ready HTML page. PRD 12 asks for PDF; a light-themed page the browser
 * prints is the same artefact without a rendering engine in the bundle, and it
 * stays legible when somebody forwards the link instead of the file.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { ApiError, notFound } from "@/lib/api";
import { assertCan, canFestWide, type Actor } from "@/lib/authz";
import { waitingOn } from "./reimbursements";
import { appUrl } from "@/lib/email";
import { formatPaise } from "@/lib/money";
import { billSignature } from "@/lib/storage";
import { buildXlsx, type Column, type Sheet } from "@/lib/xlsx";

export type ExportKind =
  | "transactions"
  | "reimbursements"
  | "department-statement"
  | "payment-batch"
  | "vendor-ledger"
  | "income-ledger"
  | "sponsor-statement"
  | "fest-summary"
  | "audit";

export type ExportFormat = "csv" | "xlsx" | "html";

export interface Filters {
  from?: string;
  to?: string;
  departmentId?: string;
  status?: string;
  lineItemId?: string;
  expenseTypeId?: string;
  vendorId?: string;
  payee?: string;
  /** `department-statement` and `sponsor-statement` are about one record. */
  id?: string;
}

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string | Buffer;
}

/* ------------------------------------------------------------------ helpers */

/** RFC 4180 quoting — a description with a comma must not shift every later column. */
export function csv(rows: Record<string, unknown>[], columns?: Column[]): string {
  if (rows.length === 0 && !columns) return "";
  const cols: Column[] = columns ?? Object.keys(rows[0]).map((key) => ({ key, header: key }));

  const cell = (value: unknown, type: Column["type"]) => {
    if (value === null || value === undefined) return "";
    if (type === "money") return (Number(value) / 100).toFixed(2);
    const s = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };

  return [
    cols.map((c) => c.header).join(","),
    ...rows.map((r) => cols.map((c) => cell(r[c.key], c.type)).join(",")),
  ].join("\r\n");
}

/** Filters that apply to a table with the standard column names. */
function whereFrom(alias: string, f: Filters, opts: { dateColumn: string; hasDepartment?: boolean }): SQL {
  const a = (col: string) => sql.raw(`${alias}.${col}`);
  return sql`
    ${f.from ? sql`and ${a(opts.dateColumn)} >= ${f.from}::date` : sql``}
    ${f.to ? sql`and ${a(opts.dateColumn)} < (${f.to}::date + 1)` : sql``}
    ${f.departmentId && opts.hasDepartment !== false ? sql`and ${a("department_id")} = ${f.departmentId}` : sql``}
    ${f.status ? sql`and ${a("status")}::text = ${f.status}` : sql``}
    ${f.lineItemId ? sql`and ${a("line_item_id")} = ${f.lineItemId}` : sql``}
  `;
}

/**
 * A Dept HOD may export their own department and nothing else (20.12). Rather than
 * trusting the `department_id` filter they sent, the scope is forced here.
 */
function scopeDepartment(actor: Actor, f: Filters): Filters {
  if (canFestWide(actor, "export.run")) return f;
  return { ...f, departmentId: actor.departmentId };
}

async function rows(query: SQL): Promise<Record<string, unknown>[]> {
  return (await db.execute(query)) as unknown as Record<string, unknown>[];
}

/* --------------------------------------------------- 12.1 transactions ledger */

const TRANSACTION_COLUMNS: Column[] = [
  { key: "reference", header: "Reference", width: 12 },
  { key: "kind", header: "Type", width: 14 },
  { key: "department", header: "Department", width: 16 },
  { key: "line_item", header: "Line item", width: 22 },
  { key: "expense_type", header: "Expense type", width: 18 },
  { key: "description", header: "Description", width: 40 },
  { key: "counterparty", header: "Paid to", width: 22 },
  { key: "transaction_on", header: "Transaction date", type: "date", width: 16 },
  { key: "amount_paise", header: "Amount", type: "money", width: 14 },
  { key: "status", header: "Status", width: 16 },
  { key: "submitted_by", header: "Raised by", width: 18 },
  { key: "endorsed_by", header: "Endorsed by", width: 18 },
  { key: "endorsed_at", header: "Endorsed at", type: "date", width: 16 },
  { key: "approved_by", header: "Approved by", width: 18 },
  { key: "approved_at", header: "Approved at", type: "date", width: 16 },
  { key: "paid_by", header: "Paid by", width: 18 },
  { key: "paid_at", header: "Paid at", type: "date", width: 16 },
  { key: "payment_reference", header: "Payment reference", width: 22 },
  { key: "open_flags", header: "Open flags", type: "number", width: 11 },
];

const REIMBURSEMENT_COLUMNS: Column[] = [
  { key: "reference", header: "Reference", width: 12 },
  { key: "status", header: "Status", width: 16 },
  { key: "waiting_on", header: "Waiting on", width: 16 },
  { key: "department", header: "Department", width: 16 },
  { key: "line_item", header: "Line item", width: 22 },
  { key: "expense_type", header: "Expense type", width: 18 },
  { key: "description", header: "Description", width: 40 },
  { key: "amount_paise", header: "Amount", type: "money", width: 14 },
  { key: "transaction_on", header: "Spent on", type: "date", width: 14 },
  { key: "payee_name", header: "Payee", width: 22 },
  { key: "payee_upi_id", header: "Payee UPI", width: 20 },
  { key: "submitted_by", header: "Raised by", width: 18 },
  { key: "submitted_at", header: "Raised at", type: "date", width: 14 },
  { key: "endorsed_by", header: "Endorsed by", width: 18 },
  { key: "endorsed_at", header: "Endorsed at", type: "date", width: 14 },
  { key: "approved_by", header: "Approved by", width: 18 },
  { key: "approved_at", header: "Approved at", type: "date", width: 14 },
  { key: "paid_by", header: "Paid by", width: 18 },
  { key: "paid_at", header: "Paid at", type: "date", width: 14 },
  { key: "payment_reference", header: "Payment reference", width: 22 },
  { key: "receipts", header: "Receipts", type: "number", width: 10 },
  { key: "open_flags", header: "Open flags", type: "number", width: 11 },
];

/**
 * The address of a bill, written into a file that may be opened months from now by
 * someone with no account here (PRD 11).
 *
 * **Whoever holds this link can open the bill**, so it is only ever written for rows
 * `reimbursementScope` already lets this caller take away. It is not a signed storage
 * URL, which would die in fifteen minutes. See `publicBillUrl`.
 */
const billLink = (attachmentId: string) =>
  `${appUrl()}/api/v1/bills/${attachmentId}?sig=${billSignature(attachmentId)}`;

/**
 * One column per bill, as many as the busiest claim in this file has: a spreadsheet
 * cell holds one link. Always at least one, so an empty file has the same shape.
 */
function billColumns(data: Record<string, unknown>[]): Column[] {
  const most = Math.max(1, ...data.map((row) => (row.attachment_ids as string[]).length));
  return Array.from({ length: most }, (_, i) => ({
    key: `bill_${i + 1}`, header: `Bill ${i + 1}`, type: "link", linkText: "Open bill", width: 12,
  }));
}

/**
 * How much of the ledger this caller may take away.
 *
 * The same three-way rule the Reimbursements screen renders from — fest-wide for
 * Finance, Management and administrators; own department for a head; own claims for
 * everybody else. Written here as SQL rather than trusted from a filter, because a
 * spreadsheet is the one artefact that leaves the building: getting this wrong does
 * not show a Member somebody else's claim on a screen they can close, it hands them
 * a file with every payee's UPI id in it.
 */
function reimbursementScope(actor: Actor): SQL {
  if (canFestWide(actor, "reimbursement.view")) return sql``;
  if (actor.role === "DEPT_HOD") return sql`and r.department_id = ${actor.departmentId}`;
  return sql`and r.submitter_id = ${actor.id}`;
}

/**
 * Reimbursements on their own, which `transactions` cannot be.
 *
 * 12.1 unions claims and vendor milestones into one ledger, which is the right
 * shape for reconciling a department and the wrong one for the question people
 * actually ask of this screen — "what has my team claimed, and where has it got
 * to". Separate columns too: a claim has a payee, a UPI id and a receipt count,
 * none of which a vendor milestone has, and a union has to drop them.
 */
async function reimbursementRows(actor: Actor, f: Filters) {
  return rows(sql`
    select r.human_id as reference, r.status::text as status,
           d.name as department, li.name as line_item, et.name as expense_type,
           r.description, r.amount_paise, r.transaction_on,
           r.payee_name, r.payee_upi_id,
           u.name as submitted_by, r.submitted_at,
           eu.name as endorsed_by, r.endorsed_at,
           au.name as approved_by, r.approved_at,
           pu.name as paid_by, r.paid_at, r.payment_reference,
           su.role::text as submitter_role,
           (select count(*)::int from attachments a
             where a.entity_type = 'REIMBURSEMENT' and a.entity_id = r.id
               and a.removed_at is null) as receipts,
           (select coalesce(json_agg(a.id order by a.created_at, a.id), '[]'::json) from attachments a
             where a.entity_type = 'REIMBURSEMENT' and a.entity_id = r.id
               and a.removed_at is null) as attachment_ids,
           (select count(*)::int from flags fl
             where fl.entity_type = 'REIMBURSEMENT' and fl.entity_id = r.id and fl.status = 'OPEN') as open_flags
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
      join expense_types et on et.id = r.expense_type_id
      join users u on u.id = r.submitter_id
      join users su on su.id = r.submitter_id
      left join users eu on eu.id = r.endorsed_by
      left join users au on au.id = r.approved_by
      left join users pu on pu.id = r.paid_by
     where r.fest_id = ${actor.festId} and r.deleted_at is null
       ${reimbursementScope(actor)}
       ${whereFrom("r", f, { dateColumn: "transaction_on" })}
       ${f.expenseTypeId ? sql`and r.expense_type_id = ${f.expenseTypeId}` : sql``}
       ${f.payee ? sql`and r.payee_name ilike ${`%${f.payee}%`}` : sql``}
     order by r.created_at desc
  `);
}

/** 12.1 — every reimbursement and every vendor milestone, with its full history. */
async function transactions(actor: Actor, f: Filters) {
  return rows(sql`
    select r.human_id as reference, 'Reimbursement' as kind, d.name as department,
           li.name as line_item, et.name as expense_type, r.description,
           r.payee_name as counterparty, r.transaction_on, r.amount_paise,
           r.status::text as status, u.name as submitted_by,
           eu.name as endorsed_by, r.endorsed_at,
           au.name as approved_by, r.approved_at,
           pu.name as paid_by, r.paid_at, r.payment_reference,
           (select count(*)::int from flags fl
             where fl.entity_type = 'REIMBURSEMENT' and fl.entity_id = r.id and fl.status = 'OPEN') as open_flags
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
      join expense_types et on et.id = r.expense_type_id
      join users u on u.id = r.submitter_id
      left join users eu on eu.id = r.endorsed_by
      left join users au on au.id = r.approved_by
      left join users pu on pu.id = r.paid_by
     where r.fest_id = ${actor.festId} and r.deleted_at is null
       ${whereFrom("r", f, { dateColumn: "transaction_on" })}
       ${f.expenseTypeId ? sql`and r.expense_type_id = ${f.expenseTypeId}` : sql``}
       ${f.payee ? sql`and r.payee_name ilike ${`%${f.payee}%`}` : sql``}
       ${f.vendorId ? sql`and false` : sql``}

    union all

    select vr.human_id || '/' || m.kind::text, 'Vendor ' || lower(m.kind::text), d.name,
           li.name, null, vr.description,
           v.name, coalesce(m.paid_at::date, vr.approved_at::date, vr.created_at::date),
           coalesce(m.paid_paise, m.planned_paise),
           case when m.paid_at is not null then 'PAID' else vr.status::text end,
           ru.name, null, null,
           au.name, vr.approved_at,
           pu.name, m.paid_at, m.payment_reference,
           (select count(*)::int from flags fl
             where fl.entity_type = 'VENDOR_REQUEST' and fl.entity_id = vr.id and fl.status = 'OPEN')
      from vendor_milestones m
      join vendor_requests vr on vr.id = m.vendor_request_id
      join vendors v on v.id = vr.vendor_id
      join departments d on d.id = vr.department_id
      join line_items li on li.id = vr.line_item_id
      join users ru on ru.id = vr.requested_by
      left join users au on au.id = vr.approved_by
      left join users pu on pu.id = m.paid_by
     where vr.fest_id = ${actor.festId} and vr.deleted_at is null
       and vr.status <> 'DRAFT'
       ${f.from ? sql`and coalesce(m.paid_at::date, vr.created_at::date) >= ${f.from}::date` : sql``}
       ${f.to ? sql`and coalesce(m.paid_at::date, vr.created_at::date) < (${f.to}::date + 1)` : sql``}
       ${f.departmentId ? sql`and vr.department_id = ${f.departmentId}` : sql``}
       ${f.lineItemId ? sql`and vr.line_item_id = ${f.lineItemId}` : sql``}
       ${f.vendorId ? sql`and vr.vendor_id = ${f.vendorId}` : sql``}
       ${f.payee ? sql`and v.name ilike ${`%${f.payee}%`}` : sql``}
       ${f.expenseTypeId ? sql`and false` : sql``}

     order by transaction_on, reference
  `);
}

/* ------------------------------------------------- 12.2 department statement */

const LINE_ITEM_COLUMNS: Column[] = [
  { key: "line_item", header: "Line item", width: 26 },
  { key: "status", header: "Status", width: 10 },
  { key: "planned_paise", header: "Planned", type: "money", width: 14 },
  { key: "pending_paise", header: "Pending", type: "money", width: 14 },
  { key: "committed_paise", header: "Committed", type: "money", width: 14 },
  { key: "spent_paise", header: "Spent", type: "money", width: 14 },
  { key: "available_paise", header: "Available", type: "money", width: 14 },
  { key: "documents", header: "Documents", type: "number", width: 11 },
  { key: "lowest_quote_paise", header: "Lowest quote", type: "money", width: 14 },
  { key: "reviewed_at", header: "Reviewed", type: "date", width: 14 },
];

async function departmentStatementData(actor: Actor, departmentId: string) {
  assertCan(actor, "department.budget.view", { festId: actor.festId, departmentId });

  const [department] = (await rows(sql`
    select d.id, d.name, d.kind::text as kind, v.allocated_paise, v.planned_paise,
           v.pending_paise, v.committed_paise, v.spent_paise, v.available_paise,
           f.name as fest_name, f.starts_on, f.ends_on
      from departments d
      join fests f on f.id = d.fest_id
      left join v_department_totals v on v.department_id = d.id
     where d.id = ${departmentId} and d.fest_id = ${actor.festId}
  `)) as Record<string, unknown>[];
  if (!department) throw notFound("Department");

  const lineItems = await rows(sql`
    select li.id, li.name as line_item, li.status::text as status,
           v.planned_paise, v.pending_paise, v.committed_paise, v.spent_paise, v.available_paise,
           li.reviewed_at,
           (select count(*)::int from attachments a
             where a.entity_type = 'LINE_ITEM' and a.entity_id = li.id and a.removed_at is null) as documents,
           (select min(a.quoted_amount_paise) from attachments a
             where a.entity_type = 'LINE_ITEM' and a.entity_id = li.id and a.removed_at is null) as lowest_quote_paise
      from line_items li
      left join v_line_item_totals v on v.line_item_id = li.id
     where li.department_id = ${departmentId} and li.deleted_at is null
     order by li.name
  `);

  const documents = await rows(sql`
    select li.name as line_item, a.label, a.source_name, a.quoted_amount_paise,
           a.kind::text as kind, a.url, a.file_name, u.name as added_by, a.created_at
      from attachments a
      join line_items li on li.id = a.entity_id
      join users u on u.id = a.uploaded_by
     where a.entity_type = 'LINE_ITEM' and a.removed_at is null
       and li.department_id = ${departmentId} and li.deleted_at is null
     order by li.name, a.created_at
  `);

  const transactionsForDept = await transactions(actor, { departmentId });

  return { department, lineItems, documents, transactions: transactionsForDept };
}

/* ------------------------------------------------------- 12.3 payment batch */

const PAYMENT_BATCH_COLUMNS: Column[] = [
  { key: "reference", header: "Reference", width: 14 },
  { key: "kind", header: "Type", width: 14 },
  { key: "payee_name", header: "Payee", width: 24 },
  { key: "payee_upi_id", header: "UPI ID", width: 24 },
  { key: "bank_account_number", header: "Account number", width: 20 },
  { key: "bank_ifsc", header: "IFSC", width: 14 },
  { key: "amount_paise", header: "Amount", type: "money", width: 14 },
  { key: "department", header: "Department", width: 16 },
  { key: "line_item", header: "Line item", width: 22 },
  { key: "description", header: "For", width: 40 },
  { key: "approved_at", header: "Approved", type: "date", width: 14 },
  { key: "open_flags", header: "Open flags", type: "number", width: 11 },
];

/** 12.3 — what Management works from when making transfers. */
async function paymentBatch(actor: Actor, f: Filters) {
  return rows(sql`
    select r.human_id as reference, 'Reimbursement' as kind,
           r.payee_name, r.payee_upi_id, null as bank_account_number, null as bank_ifsc,
           r.amount_paise, d.name as department, li.name as line_item,
           r.description, r.approved_at,
           (select count(*)::int from flags fl
             where fl.entity_type = 'REIMBURSEMENT' and fl.entity_id = r.id and fl.status = 'OPEN') as open_flags
      from reimbursement_requests r
      join departments d on d.id = r.department_id
      join line_items li on li.id = r.line_item_id
     where r.fest_id = ${actor.festId} and r.deleted_at is null and r.status = 'APPROVED'
       ${f.departmentId ? sql`and r.department_id = ${f.departmentId}` : sql``}
       ${f.payee ? sql`and r.payee_name ilike ${`%${f.payee}%`}` : sql``}

    union all

    select vr.human_id || '/' || m.kind::text, 'Vendor ' || lower(m.kind::text),
           v.name, v.upi_id, v.bank_account_number, v.bank_ifsc,
           m.planned_paise, d.name, li.name, vr.description,
           coalesce(vr.balance_approved_at, vr.approved_at),
           (select count(*)::int from flags fl
             where fl.entity_type = 'VENDOR_REQUEST' and fl.entity_id = vr.id and fl.status = 'OPEN')
      from vendor_milestones m
      join vendor_requests vr on vr.id = m.vendor_request_id
      join vendors v on v.id = vr.vendor_id
      join departments d on d.id = vr.department_id
      join line_items li on li.id = vr.line_item_id
     where vr.fest_id = ${actor.festId} and vr.deleted_at is null
       and m.paid_at is null and m.planned_paise > 0
       and ((m.kind = 'ADVANCE' and vr.status = 'APPROVED')
         or (m.kind <> 'ADVANCE' and vr.status = 'BALANCE_APPROVED'))
       ${f.departmentId ? sql`and vr.department_id = ${f.departmentId}` : sql``}
       ${f.vendorId ? sql`and vr.vendor_id = ${f.vendorId}` : sql``}
       ${f.payee ? sql`and v.name ilike ${`%${f.payee}%`}` : sql``}

     order by payee_name, reference
  `);
}

/* ------------------------------------------------------- 12.4 vendor ledger */

const VENDOR_COLUMNS: Column[] = [
  { key: "vendor", header: "Vendor", width: 26 },
  { key: "contact_name", header: "Contact", width: 18 },
  { key: "phone", header: "Phone", width: 15 },
  { key: "gstin", header: "GSTIN", width: 18 },
  { key: "requests", header: "Requests", type: "number", width: 11 },
  { key: "contracted_paise", header: "Contracted", type: "money", width: 15 },
  { key: "paid_paise", header: "Paid", type: "money", width: 15 },
  { key: "outstanding_paise", header: "Outstanding", type: "money", width: 15 },
  { key: "refund_expected_paise", header: "Refund expected", type: "money", width: 16 },
  { key: "refund_received_paise", header: "Refund received", type: "money", width: 16 },
  { key: "overdue_deliveries", header: "Late deliveries", type: "number", width: 14 },
];

/** 12.4 — per vendor: contracted, paid, outstanding, refunds. */
async function vendorLedger(actor: Actor, f: Filters) {
  return rows(sql`
    select v.name as vendor, v.contact_name, v.phone, v.gstin,
           count(vr.id)::int as requests,
           coalesce(sum(coalesce(vr.approved_value_paise, vr.total_value_paise))
                    filter (where vr.status not in ('DRAFT','DECLINED')), 0) as contracted_paise,
           coalesce(sum(paid.total), 0) as paid_paise,
           coalesce(sum(coalesce(vr.approved_value_paise, vr.total_value_paise) - coalesce(paid.total, 0))
                    filter (where vr.status not in ('DRAFT','DECLINED','CANCELLED')), 0) as outstanding_paise,
           coalesce(sum(vr.refund_expected_paise), 0) as refund_expected_paise,
           coalesce(sum(vr.refund_received_paise), 0) as refund_received_paise,
           count(*) filter (where vr.delivered_at is null
                              and vr.expected_delivery_on < current_date
                              and vr.status not in ('CLOSED','DECLINED','CANCELLED','DRAFT'))::int as overdue_deliveries
      from vendors v
      left join vendor_requests vr on vr.vendor_id = v.id and vr.deleted_at is null
        ${f.departmentId ? sql`and vr.department_id = ${f.departmentId}` : sql``}
      left join lateral (
        select coalesce(sum(m.paid_paise), 0) as total
          from vendor_milestones m where m.vendor_request_id = vr.id
      ) paid on true
     where v.fest_id = ${actor.festId} and v.deleted_at is null
       ${f.vendorId ? sql`and v.id = ${f.vendorId}` : sql``}
     group by v.id, v.name, v.contact_name, v.phone, v.gstin
     order by outstanding_paise desc, v.name
  `);
}

/* ------------------------------------------------------- 12.5 income ledger */

const INCOME_COLUMNS: Column[] = [
  { key: "type", header: "Type", width: 22 },
  { key: "source_name", header: "Source", width: 26 },
  { key: "owning_department", header: "Department", width: 16 },
  { key: "status", header: "Status", width: 18 },
  { key: "pledged_paise", header: "Pledged", type: "money", width: 15 },
  { key: "received_paise", header: "Received", type: "money", width: 15 },
  { key: "outstanding_paise", header: "Outstanding", type: "money", width: 15 },
  { key: "pledged_on", header: "Pledged on", type: "date", width: 14 },
  { key: "last_received_on", header: "Last receipt", type: "date", width: 14 },
  { key: "counts_toward_cash", header: "Counts as cash", width: 14 },
  { key: "references", header: "References", width: 30 },
  { key: "written_off_reason", header: "Written off because", width: 30 },
];

async function incomeLedgerRows(actor: Actor, f: Filters) {
  return rows(sql`
    select e.type::text as type, e.source_name, d.name as owning_department, e.status::text as status,
           e.pledged_paise,
           coalesce(t.received, 0) as received_paise,
           greatest(e.pledged_paise - coalesce(t.received, 0), 0) as outstanding_paise,
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
     where e.fest_id = ${actor.festId} and e.deleted_at is null
       ${f.status ? sql`and e.status::text = ${f.status}` : sql``}
       ${f.from ? sql`and e.pledged_on >= ${f.from}::date` : sql``}
       ${f.to ? sql`and e.pledged_on < (${f.to}::date + 1)` : sql``}
     order by e.type, e.source_name
  `);
}

async function sponsorStatementData(actor: Actor, id: string) {
  assertCan(actor, "income.view", { festId: actor.festId });

  const [entry] = (await rows(sql`
    select e.id, e.type::text as type, e.source_name, e.status::text as status,
           e.pledged_paise, e.pledged_on, e.notes, e.written_off_reason,
           d.name as owning_department, f.name as fest_name,
           coalesce((select sum(amount_paise) from income_tranches t where t.income_entry_id = e.id), 0) as received_paise
      from income_entries e
      join fests f on f.id = e.fest_id
      left join departments d on d.id = e.owning_department_id
     where e.id = ${id} and e.fest_id = ${actor.festId} and e.deleted_at is null
  `)) as Record<string, unknown>[];
  if (!entry) throw notFound("Income entry");

  const tranches = await rows(sql`
    select t.received_on, t.amount_paise, t.reference, u.name as recorded_by, t.created_at
      from income_tranches t
      join users u on u.id = t.recorded_by
     where t.income_entry_id = ${id}
     order by t.received_on, t.created_at
  `);

  return { entry, tranches };
}

/* -------------------------------------------------------- 12.6 fest summary */

async function festSummaryData(actor: Actor) {
  assertCan(actor, "income.view", { festId: actor.festId });

  const [totals] = (await rows(sql`select * from v_fest_totals where fest_id = ${actor.festId}`)) as Record<string, unknown>[];
  if (!totals) throw notFound("Fest");

  const [fest] = (await rows(sql`
    select name, starts_on, ends_on, total_budget_paise from fests where id = ${actor.festId}
  `)) as Record<string, unknown>[];

  const byDepartment = await rows(sql`
    select d.name as department, d.kind::text as kind, v.allocated_paise, v.planned_paise,
           v.pending_paise, v.committed_paise, v.spent_paise, v.available_paise,
           case when v.allocated_paise = 0 then 0
                else round(((v.committed_paise + v.spent_paise)::numeric / v.allocated_paise) * 100, 1)
           end as utilization_pct
      from v_department_totals v
      join departments d on d.id = v.department_id
     where v.fest_id = ${actor.festId}
     order by v.allocated_paise desc
  `);

  const byExpenseType = await rows(sql`
    select et.name as expense_type,
           count(*)::int as requests,
           coalesce(sum(r.amount_paise) filter (where r.status = 'PAID'), 0) as spent_paise,
           coalesce(sum(r.amount_paise) filter (
             where r.status in ('SUBMITTED','HOD_ENDORSED','APPROVED','ON_HOLD')), 0) as committed_paise
      from reimbursement_requests r
      join expense_types et on et.id = r.expense_type_id
     where r.fest_id = ${actor.festId} and r.deleted_at is null
       and r.status not in ('DRAFT','DECLINED','WITHDRAWN')
     group by et.name
     order by spent_paise desc
  `);

  const income = await rows(sql`
    select type::text as type, pledged_paise, received_paise, expected_paise
      from v_income_totals where fest_id = ${actor.festId} order by type
  `);

  const [openItems] = (await rows(sql`
    select
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = ${actor.festId} and r.deleted_at is null
          and r.status in ('SUBMITTED','HOD_ENDORSED','APPROVED','ON_HOLD'))          as open_reimbursements,
      (select count(*)::int from vendor_requests vr
        where vr.fest_id = ${actor.festId} and vr.deleted_at is null
          and vr.status not in ('CLOSED','DECLINED','CANCELLED','DRAFT'))             as open_vendor_requests,
      (select count(*)::int from flags fl
        where fl.fest_id = ${actor.festId} and fl.status = 'OPEN')                    as open_flags,
      (select count(*)::int from tickets t
        where t.fest_id = ${actor.festId} and t.deleted_at is null
          and t.status not in ('CLOSED','REJECTED','CANCELLED'))                      as open_tickets,
      (select count(*)::int from income_entries e
        where e.fest_id = ${actor.festId} and e.deleted_at is null
          and e.status in ('PLEDGED','PARTIALLY_RECEIVED'))                           as unreceived_pledges
  `)) as Record<string, unknown>[];

  return { fest, totals, byDepartment, byExpenseType, income, openItems };
}

/* ------------------------------------------------------------- 12.7 audit log */

const AUDIT_COLUMNS: Column[] = [
  { key: "created_at", header: "When", type: "date", width: 18 },
  { key: "actor", header: "Who", width: 20 },
  { key: "entity_type", header: "Record type", width: 16 },
  { key: "reference", header: "Record", width: 16 },
  { key: "action", header: "Action", width: 32 },
  { key: "reason", header: "Reason", width: 40 },
  { key: "before_json", header: "Before", width: 40 },
  { key: "after_json", header: "After", width: 40 },
];

async function auditRows(actor: Actor, f: Filters) {
  return rows(sql`
    select a.created_at, u.name as actor, a.entity_type::text as entity_type,
           coalesce(r.human_id, vr.human_id, t.human_id, li.name, d.name) as reference,
           a.action, a.reason,
           a.before::text as before_json, a.after::text as after_json
      from audit_events a
      left join users u on u.id = a.actor_id
      left join reimbursement_requests r on a.entity_type = 'REIMBURSEMENT' and r.id = a.entity_id
      left join vendor_requests vr on a.entity_type = 'VENDOR_REQUEST' and vr.id = a.entity_id
      left join tickets t on a.entity_type = 'TICKET' and t.id = a.entity_id
      left join line_items li on a.entity_type = 'LINE_ITEM' and li.id = a.entity_id
      left join departments d on a.entity_type = 'DEPARTMENT' and d.id = a.entity_id
     where a.fest_id = ${actor.festId}
       ${f.from ? sql`and a.created_at >= ${f.from}::date` : sql``}
       ${f.to ? sql`and a.created_at < (${f.to}::date + 1)` : sql``}
     order by a.created_at
  `);
}

/* ------------------------------------------------------- print-ready HTML */

const money = (v: unknown) => formatPaise(Number(v ?? 0));

/**
 * The light-themed statement pages (PRD 21.4 — exports and emails are light,
 * regardless of the app's dark shell). Styled for A4 so a browser's "print to
 * PDF" produces the artefact section 12 asks for.
 */
function htmlDocument(title: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  @page { size: A4; margin: 16mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.5 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
         color: #1a1a1a; background: #fff; margin: 0; padding: 24px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #d8d8d4; }
  .sub { color: #6b6b6b; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
       color: #6b6b6b; border-bottom: 1px solid #d8d8d4; padding: 6px 8px 6px 0; }
  td { padding: 6px 8px 6px 0; border-bottom: 1px solid #eeeeea; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { font-weight: 600; border-top: 2px solid #d8d8d4; border-bottom: none; }
  .cards { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .card { border: 1px solid #d8d8d4; border-radius: 8px; padding: 10px 14px; min-width: 150px; }
  .card .k { font-size: 11px; color: #6b6b6b; }
  .card .v { font-size: 16px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .foot { margin-top: 32px; padding-top: 10px; border-top: 1px solid #d8d8d4;
          font-size: 10px; color: #6b6b6b; }
  @media print { body { padding: 0; } tr { break-inside: avoid; } h2 { break-after: avoid; } }
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(subtitle)}</p>
${body}
<p class="foot">Generated ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC from the Yugaantar
finance and operations platform. Amounts are in rupees. The platform record is the source of truth.</p>
</body></html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!),
  );
}

function htmlTable(columns: Column[], data: Record<string, unknown>[], totalsRow?: Record<string, unknown>): string {
  const isNum = (c: Column) => c.type === "money" || c.type === "number";
  const cell = (c: Column, row: Record<string, unknown>) => {
    const v = row[c.key];
    if (v === null || v === undefined || v === "") return "";
    if (c.type === "money") return money(v);
    if (c.type === "date") return v instanceof Date ? v.toISOString().slice(0, 10) : escapeHtml(v);
    return escapeHtml(v);
  };
  return `<table>
<thead><tr>${columns.map((c) => `<th class="${isNum(c) ? "num" : ""}">${escapeHtml(c.header)}</th>`).join("")}</tr></thead>
<tbody>${data
    .map((row) => `<tr>${columns.map((c) => `<td class="${isNum(c) ? "num" : ""}">${cell(c, row)}</td>`).join("")}</tr>`)
    .join("")}</tbody>
${totalsRow ? `<tfoot><tr>${columns.map((c) => `<td class="${isNum(c) ? "num" : ""}">${cell(c, totalsRow)}</td>`).join("")}</tr></tfoot>` : ""}
</table>`;
}

function cards(entries: [string, string][]): string {
  return `<div class="cards">${entries
    .map(([k, v]) => `<div class="card"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`)
    .join("")}</div>`;
}

/* -------------------------------------------------------------- the entry point */

const PERMISSION: Record<ExportKind, Parameters<typeof assertCan>[1]> = {
  transactions: "export.run",
  /*
   * Not `export.run`, which is Finance, Management and heads: everyone may see
   * *some* reimbursements — their own at least — so everyone may take that same
   * list away with them. `reimbursement.create` is the gate because it is the one
   * every role in the fest passes (5.1: anybody may claim money they spent), and
   * because somebody who may file a claim is exactly somebody who has claims worth
   * exporting.
   *
   * `reimbursement.view` cannot be the gate even though it reads as the right
   * question: it is answered per row, from a `submitterId`, and there is no single
   * row to hand it here. How much of the ledger comes out is decided by
   * `reimbursementScope`, not by this.
   */
  reimbursements: "reimbursement.create",
  "department-statement": "export.run",
  "payment-batch": "export.run",
  "vendor-ledger": "vendor.view",
  "income-ledger": "income.view",
  "sponsor-statement": "income.view",
  "fest-summary": "income.view",
  audit: "audit.view",
};

export const EXPORT_KINDS: ExportKind[] = Object.keys(PERMISSION) as ExportKind[];

/**
 * The permission gate, callable on its own so the route can satisfy 18.2 rule 1
 * before doing anything else — including consuming a rate-limit slot. A caller who
 * may not run an export must not be able to spend anyone's quota by asking.
 */
export function assertCanExport(actor: Actor, kind: ExportKind): void {
  assertCan(actor, PERMISSION[kind], { festId: actor.festId, departmentId: actor.departmentId });
}

const CSV_TYPE = "text/csv; charset=utf-8";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const HTML_TYPE = "text/html; charset=utf-8";

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function deliver(kind: string, format: ExportFormat, sheets: Sheet[]): ExportResult {
  const filename = `yugaantar-${kind}-${stamp()}.${format === "xlsx" ? "xlsx" : "csv"}`;
  if (format === "xlsx") {
    return { filename, contentType: XLSX_TYPE, body: buildXlsx(sheets) };
  }
  // CSV is one table by definition; a multi-sheet export flattens to its first.
  const [first] = sheets;
  return { filename, contentType: CSV_TYPE, body: csv(first.rows as Record<string, unknown>[], first.columns) };
}

export async function runExport(actor: Actor, kind: ExportKind, format: ExportFormat, filters: Filters = {}): Promise<ExportResult> {
  assertCanExport(actor, kind);
  const f = scopeDepartment(actor, filters);

  switch (kind) {
    /* ------------------------------------------------------------------ 12.1 */
    case "transactions": {
      const data = await transactions(actor, f);
      return deliver("transactions", format, [
        { name: "Transactions", columns: TRANSACTION_COLUMNS, rows: data },
      ]);
    }

    case "reimbursements": {
      const data = await reimbursementRows(actor, f);
      // "Waiting on" is derived rather than stored — the same function the list
      // screen uses, so the column and the screen cannot drift apart.
      const withWaiting = data.map((row) => ({
        ...row,
        waiting_on: waitingOn(
          row.status as Parameters<typeof waitingOn>[0],
          row.submitter_role as Parameters<typeof waitingOn>[1],
        ),
        ...Object.fromEntries(
          (row.attachment_ids as string[]).map((id, i) => [`bill_${i + 1}`, billLink(id)]),
        ),
      }));
      return deliver("reimbursements", format, [
        {
          name: "Reimbursements",
          columns: [...REIMBURSEMENT_COLUMNS, ...billColumns(data)],
          rows: withWaiting,
        },
      ]);
    }

    /* ------------------------------------------------------------------ 12.3 */
    case "payment-batch": {
      const data = await paymentBatch(actor, f);
      return deliver("payment-batch", format, [
        { name: "Payment batch", columns: PAYMENT_BATCH_COLUMNS, rows: data },
      ]);
    }

    /* ------------------------------------------------------------------ 12.4 */
    case "vendor-ledger": {
      const data = await vendorLedger(actor, f);
      return deliver("vendor-ledger", format, [
        { name: "Vendors", columns: VENDOR_COLUMNS, rows: data },
      ]);
    }

    /* ------------------------------------------------------------------ 12.5 */
    case "income-ledger": {
      const data = await incomeLedgerRows(actor, f);
      return deliver("income-ledger", format, [
        { name: "Income", columns: INCOME_COLUMNS, rows: data },
      ]);
    }

    /* ------------------------------------------------------------------ 12.7 */
    case "audit": {
      const data = await auditRows(actor, f);
      return deliver("audit-log", format, [
        { name: "Audit log", columns: AUDIT_COLUMNS, rows: data },
      ]);
    }

    /* ------------------------------------------------------------------ 12.2 */
    case "department-statement": {
      if (!f.id) throw new ApiError("VALIDATION_ERROR", "A department is required");
      const { department, lineItems, documents, transactions: txns } = await departmentStatementData(actor, f.id);

      if (format === "html") {
        const totalsRow = {
          line_item: `${lineItems.length} line item${lineItems.length === 1 ? "" : "s"}`,
          planned_paise: sum(lineItems, "planned_paise"),
          pending_paise: sum(lineItems, "pending_paise"),
          committed_paise: sum(lineItems, "committed_paise"),
          spent_paise: sum(lineItems, "spent_paise"),
          available_paise: sum(lineItems, "available_paise"),
        };
        return {
          filename: `yugaantar-department-statement-${stamp()}.html`,
          contentType: HTML_TYPE,
          body: htmlDocument(
            `${department.name} — department statement`,
            `${department.fest_name} · ${department.starts_on} to ${department.ends_on}`,
            [
              cards([
                ["Allocated", money(department.allocated_paise)],
                ["Planned", money(department.planned_paise)],
                ["Pending", money(department.pending_paise)],
                ["Committed", money(department.committed_paise)],
                ["Spent", money(department.spent_paise)],
                ["Available", money(department.available_paise)],
              ]),
              `<h2>Line items</h2>`,
              htmlTable(LINE_ITEM_COLUMNS, lineItems, totalsRow),
              `<h2>Supporting documents</h2>`,
              htmlTable(
                [
                  { key: "line_item", header: "Line item" },
                  { key: "label", header: "Document" },
                  { key: "source_name", header: "Source" },
                  { key: "quoted_amount_paise", header: "Quoted", type: "money" },
                  { key: "kind", header: "Kind" },
                  { key: "url", header: "Link" },
                  { key: "added_by", header: "Added by" },
                ],
                documents,
              ),
              `<h2>Transactions</h2>`,
              htmlTable(
                TRANSACTION_COLUMNS.filter((c) =>
                  ["reference", "kind", "line_item", "description", "counterparty", "transaction_on", "amount_paise", "status"].includes(c.key),
                ),
                txns,
              ),
            ].join("\n"),
          ),
        };
      }

      return deliver("department-statement", format, [
        { name: "Line items", columns: LINE_ITEM_COLUMNS, rows: lineItems },
        {
          name: "Documents",
          columns: [
            { key: "line_item", header: "Line item", width: 24 },
            { key: "label", header: "Document", width: 26 },
            { key: "source_name", header: "Source", width: 20 },
            { key: "quoted_amount_paise", header: "Quoted", type: "money", width: 14 },
            { key: "kind", header: "Kind", width: 8 },
            { key: "url", header: "Link", width: 40 },
            { key: "file_name", header: "File", width: 26 },
            { key: "added_by", header: "Added by", width: 18 },
          ],
          rows: documents,
        },
        { name: "Transactions", columns: TRANSACTION_COLUMNS, rows: txns },
      ]);
    }

    /* ------------------------------------------------------- 12.5 sponsor */
    case "sponsor-statement": {
      if (!f.id) throw new ApiError("VALIDATION_ERROR", "An income entry is required");
      const { entry, tranches } = await sponsorStatementData(actor, f.id);
      const outstanding = Math.max(Number(entry.pledged_paise) - Number(entry.received_paise), 0);

      const trancheColumns: Column[] = [
        { key: "received_on", header: "Received on", type: "date", width: 14 },
        { key: "amount_paise", header: "Amount", type: "money", width: 15 },
        { key: "reference", header: "Reference", width: 26 },
        { key: "recorded_by", header: "Recorded by", width: 20 },
      ];

      if (format === "html") {
        return {
          filename: `yugaantar-sponsor-statement-${stamp()}.html`,
          contentType: HTML_TYPE,
          body: htmlDocument(
            `${entry.source_name} — statement`,
            `${entry.fest_name} · ${String(entry.type).replaceAll("_", " ").toLowerCase()}`,
            [
              cards([
                ["Pledged", money(entry.pledged_paise)],
                ["Received", money(entry.received_paise)],
                ["Outstanding", money(outstanding)],
                ["Status", String(entry.status).replaceAll("_", " ")],
              ]),
              `<h2>Receipts</h2>`,
              htmlTable(trancheColumns, tranches, {
                received_on: `${tranches.length} receipt${tranches.length === 1 ? "" : "s"}`,
                amount_paise: entry.received_paise,
              }),
              entry.written_off_reason
                ? `<h2>Written off</h2><p>${escapeHtml(entry.written_off_reason)}</p>`
                : "",
              entry.notes ? `<h2>Notes</h2><p>${escapeHtml(entry.notes)}</p>` : "",
            ].join("\n"),
          ),
        };
      }

      return deliver("sponsor-statement", format, [
        { name: "Receipts", columns: trancheColumns, rows: tranches },
      ]);
    }

    /* ------------------------------------------------------------------ 12.6 */
    case "fest-summary": {
      const { fest, totals, byDepartment, byExpenseType, income, openItems } = await festSummaryData(actor);

      const deptColumns: Column[] = [
        { key: "department", header: "Department", width: 20 },
        { key: "allocated_paise", header: "Allocated", type: "money", width: 15 },
        { key: "planned_paise", header: "Planned", type: "money", width: 15 },
        { key: "pending_paise", header: "Pending", type: "money", width: 15 },
        { key: "committed_paise", header: "Committed", type: "money", width: 15 },
        { key: "spent_paise", header: "Spent", type: "money", width: 15 },
        { key: "available_paise", header: "Available", type: "money", width: 15 },
        { key: "utilization_pct", header: "Utilisation %", type: "number", width: 13 },
      ];
      const expenseColumns: Column[] = [
        { key: "expense_type", header: "Expense type", width: 24 },
        { key: "requests", header: "Requests", type: "number", width: 11 },
        { key: "committed_paise", header: "Committed", type: "money", width: 15 },
        { key: "spent_paise", header: "Spent", type: "money", width: 15 },
      ];
      const incomeColumns: Column[] = [
        { key: "type", header: "Income type", width: 24 },
        { key: "pledged_paise", header: "Pledged", type: "money", width: 15 },
        { key: "received_paise", header: "Received", type: "money", width: 15 },
        { key: "expected_paise", header: "Expected", type: "money", width: 15 },
      ];

      if (format === "html") {
        return {
          filename: `yugaantar-fest-summary-${stamp()}.html`,
          contentType: HTML_TYPE,
          body: htmlDocument(
            `${fest.name} — closing report`,
            `${fest.starts_on} to ${fest.ends_on}`,
            [
              cards([
                ["Total budget", money(totals.total_budget_paise)],
                ["Allocated", money(totals.allocated_paise)],
                ["Reserve", money(totals.reserve_paise)],
                ["Committed", money(totals.committed_paise)],
                ["Spent", money(totals.spent_paise)],
                ["Income received", money(totals.income_received_paise)],
                ["Cash position", money(totals.cash_position_paise)],
                ["Projected close", money(totals.projected_close_paise)],
              ]),
              `<h2>Spend by department</h2>`,
              htmlTable(deptColumns, byDepartment, {
                department: "All departments",
                allocated_paise: sum(byDepartment, "allocated_paise"),
                planned_paise: sum(byDepartment, "planned_paise"),
                pending_paise: sum(byDepartment, "pending_paise"),
                committed_paise: sum(byDepartment, "committed_paise"),
                spent_paise: sum(byDepartment, "spent_paise"),
                available_paise: sum(byDepartment, "available_paise"),
              }),
              `<h2>Spend by expense type</h2>`,
              htmlTable(expenseColumns, byExpenseType),
              `<h2>Income</h2>`,
              htmlTable(incomeColumns, income, {
                type: "All income",
                pledged_paise: sum(income, "pledged_paise"),
                received_paise: sum(income, "received_paise"),
                expected_paise: sum(income, "expected_paise"),
              }),
              `<h2>Still open at the time of this report</h2>`,
              htmlTable(
                [
                  { key: "open_reimbursements", header: "Reimbursements", type: "number" },
                  { key: "open_vendor_requests", header: "Vendor requests", type: "number" },
                  { key: "unreceived_pledges", header: "Unreceived pledges", type: "number" },
                  { key: "open_flags", header: "Open flags", type: "number" },
                  { key: "open_tickets", header: "Work tickets", type: "number" },
                ],
                [openItems],
              ),
            ].join("\n"),
          ),
        };
      }

      return deliver("fest-summary", format, [
        {
          name: "Summary",
          columns: [
            { key: "measure", header: "Measure", width: 26 },
            { key: "amount_paise", header: "Amount", type: "money", width: 18 },
          ],
          rows: [
            { measure: "Total budget", amount_paise: totals.total_budget_paise },
            { measure: "Allocated to departments", amount_paise: totals.allocated_paise },
            { measure: "Reserve", amount_paise: totals.reserve_paise },
            { measure: "Pending", amount_paise: totals.pending_paise },
            { measure: "Committed", amount_paise: totals.committed_paise },
            { measure: "Spent", amount_paise: totals.spent_paise },
            { measure: "Income received", amount_paise: totals.income_received_paise },
            { measure: "Income pledged, unreceived", amount_paise: totals.income_pledged_paise },
            { measure: "Income expected", amount_paise: totals.income_expected_paise },
            { measure: "Cash position", amount_paise: totals.cash_position_paise },
            { measure: "Projected close", amount_paise: totals.projected_close_paise },
          ],
        },
        { name: "By department", columns: deptColumns, rows: byDepartment },
        { name: "By expense type", columns: expenseColumns, rows: byExpenseType },
        { name: "Income", columns: incomeColumns, rows: income },
      ]);
    }
  }
}

function sum(data: Record<string, unknown>[], key: string): number {
  return data.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}
