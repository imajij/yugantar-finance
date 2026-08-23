/**
 * Runs the relevant rule set after every write and reconciles the `flags` table:
 * a rule that now fires opens a flag, a rule that no longer fires closes its open one.
 *
 * A partial unique index (`flags_one_open_per_rule`) keeps at most one OPEN flag per
 * (entity, rule), so re-evaluation is idempotent.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { flags } from "@/db/schema";
import { lineItemTotals, departmentTotals } from "@/lib/queries/budget";
import {
  F8_largeAdvance, F9_invoiceMismatch, F12_deliveryOverdue,
  F13_missingSupport, F14_aboveQuote, REIMBURSEMENT_RULES,
  type LineItemFacts, type ReimbursementFacts, type VendorFacts,
} from "./rules";
import { thresholdsFrom, type FlagResult } from "./types";

export * from "./types";
export * from "./rules";

/** Opens what fires, closes what no longer does. Dismissed flags stay dismissed. */
async function reconcile(
  tx: Tx, festId: string, entityType: "REIMBURSEMENT" | "LINE_ITEM" | "VENDOR_REQUEST",
  entityId: string, results: FlagResult[],
): Promise<void> {
  const firing = new Set(results.map((r) => r.rule));

  for (const r of results) {
    await tx.insert(flags).values({
      festId, entityType, entityId, rule: r.rule, severity: r.severity, explanation: r.explanation,
    }).onConflictDoNothing();
    // Keep the explanation current even when the flag was already open.
    await tx.update(flags).set({ explanation: r.explanation, severity: r.severity })
      .where(and(
        eq(flags.entityType, entityType), eq(flags.entityId, entityId),
        eq(flags.rule, r.rule), eq(flags.status, "OPEN"),
      ));
  }

  const stale = await tx.select({ id: flags.id, rule: flags.rule }).from(flags)
    .where(and(eq(flags.entityType, entityType), eq(flags.entityId, entityId), eq(flags.status, "OPEN")));
  for (const s of stale) {
    if (firing.has(s.rule)) continue;
    // The condition went away — resolve it as the system, not as a user dismissal.
    await tx.update(flags)
      .set({ status: "DISMISSED", resolvedAt: new Date(), resolutionNote: "No longer applies" })
      .where(eq(flags.id, s.id));
  }
}

export async function evaluateReimbursementFlags(tx: Tx, requestId: string): Promise<FlagResult[]> {
  const [row] = (await tx.execute(sql`
    select r.id, r.fest_id, r.human_id, r.amount_paise, r.transaction_on, r.merchant,
           r.payee_upi_id, r.line_item_id, r.department_id, r.status,
           f.receipt_window_start, f.receipt_window_end, f.settings
    from reimbursement_requests r
    join fests f on f.id = r.fest_id
    where r.id = ${requestId}
  `)) as unknown as Record<string, unknown>[];
  if (!row) return [];

  const festId = String(row.fest_id);
  const thresholds = thresholdsFrom(row.settings);
  const amountPaise = Number(row.amount_paise);

  // F1 — the same receipt file, or the same amount + date + merchant, already live.
  const [dup] = (await tx.execute(sql`
    with mine as (
      select sha256 from attachments
      where entity_type = 'REIMBURSEMENT' and entity_id = ${requestId} and removed_at is null and sha256 is not null
    )
    select other.human_id, 'hash' as reason
      from attachments a
      join reimbursement_requests other on other.id = a.entity_id
     where a.entity_type = 'REIMBURSEMENT' and a.removed_at is null
       and a.sha256 in (select sha256 from mine)
       and other.id <> ${requestId} and other.fest_id = ${festId}
       and other.status not in ('DECLINED','WITHDRAWN') and other.deleted_at is null
    union all
    select other.human_id, 'details' as reason
      from reimbursement_requests other
     where other.id <> ${requestId} and other.fest_id = ${festId}
       and other.amount_paise = ${amountPaise}
       and other.transaction_on = ${row.transaction_on}
       and other.merchant is not distinct from ${row.merchant ?? null}
       and other.merchant is not null
       and other.status not in ('DECLINED','WITHDRAWN') and other.deleted_at is null
    limit 1
  `)) as unknown as { human_id: string; reason: "hash" | "details" }[];

  // OCR output lives on the receipt attachment (8.1); null until v1.1 wires it.
  const [ocr] = (await tx.execute(sql`
    select ocr_json from attachments
    where entity_type = 'REIMBURSEMENT' and entity_id = ${requestId}
      and removed_at is null and ocr_json is not null
    limit 1
  `)) as unknown as { ocr_json: { total_paise?: number; date?: string } | null }[];

  const [payee] = (await tx.execute(sql`
    select count(*) as count, coalesce(sum(amount_paise), 0) as total
    from reimbursement_requests
    where fest_id = ${festId} and payee_upi_id = ${row.payee_upi_id}
      and id <> ${requestId} and status not in ('DRAFT','DECLINED','WITHDRAWN') and deleted_at is null
  `)) as unknown as { count: string; total: string }[];

  const [li, dept] = await Promise.all([
    lineItemTotals(String(row.line_item_id), tx),
    departmentTotals(String(row.department_id), tx),
  ]);

  // Available already counts this request once it has left DRAFT — add it back so
  // F5 asks "would approving this take us below zero", not "did it already".
  const counted = ["SUBMITTED", "HOD_ENDORSED", "APPROVED", "ON_HOLD", "PAID"].includes(String(row.status));
  const addBack = counted ? amountPaise : 0;

  const facts: ReimbursementFacts = {
    amountPaise,
    transactionOn: String(row.transaction_on),
    merchant: (row.merchant as string) ?? null,
    payeeUpiId: String(row.payee_upi_id),
    ocrTotalPaise: ocr?.ocr_json?.total_paise ?? null,
    ocrHasTotal: ocr?.ocr_json?.total_paise != null,
    ocrHasDate: Boolean(ocr?.ocr_json?.date),
    ocrRan: Boolean(ocr?.ocr_json),
    duplicateOf: dup?.human_id ?? null,
    duplicateReason: dup?.reason ?? null,
    lineItemAvailablePaise: (li?.availablePaise ?? 0) + addBack,
    departmentAvailablePaise: (dept?.availablePaise ?? 0) + addBack,
    payeeRequestCount: Number(payee?.count ?? 0),
    payeeTotalPaise: Number(payee?.total ?? 0),
    receiptWindowStart: String(row.receipt_window_start),
    receiptWindowEnd: String(row.receipt_window_end),
  };

  const results = REIMBURSEMENT_RULES
    .map((rule) => rule(facts, thresholds))
    .filter((r): r is FlagResult => r !== null);

  await reconcile(tx, festId, "REIMBURSEMENT", requestId, results);
  return results;
}

export async function evaluateLineItemFlags(tx: Tx, lineItemId: string): Promise<FlagResult[]> {
  const [row] = (await tx.execute(sql`
    select li.id, li.fest_id, li.planned_paise, f.settings,
           coalesce((f.settings->>'line_item_doc_threshold_paise')::bigint, 0) as threshold,
           (select count(*) from attachments a
             where a.entity_type = 'LINE_ITEM' and a.entity_id = li.id and a.removed_at is null) as docs,
           (select min(quoted_amount_paise) from attachments a
             where a.entity_type = 'LINE_ITEM' and a.entity_id = li.id
               and a.removed_at is null and a.quoted_amount_paise is not null) as lowest_quote
    from line_items li join fests f on f.id = li.fest_id
    where li.id = ${lineItemId} and li.deleted_at is null
  `)) as unknown as Record<string, unknown>[];
  if (!row) return [];

  const thresholds = thresholdsFrom(row.settings);
  const facts: LineItemFacts = {
    plannedPaise: Number(row.planned_paise),
    documentCount: Number(row.docs),
    lowestQuotePaise: row.lowest_quote === null ? null : Number(row.lowest_quote),
    docThresholdPaise: Number(row.threshold),
  };

  const results = [F13_missingSupport(facts), F14_aboveQuote(facts, thresholds)]
    .filter((r): r is FlagResult => r !== null);

  await reconcile(tx, String(row.fest_id), "LINE_ITEM", lineItemId, results);
  return results;
}

/**
 * F8, F9 and F12 on a vendor request (8.2). F12 is also swept nightly by
 * /api/v1/cron/vendor-overdue, because "the date passed" needs no write to become true.
 */
export async function evaluateVendorFlags(tx: Tx, requestId: string): Promise<FlagResult[]> {
  const [row] = (await tx.execute(sql`
    select vr.id, vr.fest_id, vr.total_value_paise, vr.approved_value_paise,
           vr.expected_delivery_on, vr.delivered_at, vr.status, f.settings,
           current_date::text as today,
           coalesce((select planned_paise from vendor_milestones
                      where vendor_request_id = vr.id and kind = 'ADVANCE'
                      order by sort_order limit 1), 0) as advance_paise,
           (select quoted_amount_paise from attachments
             where entity_type = 'VENDOR_REQUEST' and entity_id = vr.id
               and purpose = 'INVOICE' and removed_at is null
               and quoted_amount_paise is not null
             order by created_at desc limit 1) as invoice_total
    from vendor_requests vr join fests f on f.id = vr.fest_id
    where vr.id = ${requestId} and vr.deleted_at is null
  `)) as unknown as Record<string, unknown>[];
  if (!row) return [];

  const thresholds = thresholdsFrom(row.settings);
  const facts: VendorFacts = {
    totalValuePaise: Number(row.total_value_paise),
    advancePaise: Number(row.advance_paise),
    approvedValuePaise: row.approved_value_paise === null ? null : Number(row.approved_value_paise),
    invoiceTotalPaise: row.invoice_total === null ? null : Number(row.invoice_total),
    expectedDeliveryOn: (row.expected_delivery_on as string) ?? null,
    deliveredAt: (row.delivered_at as Date) ?? null,
    today: String(row.today),
  };

  // A settled request is history — stop nagging about its delivery date.
  const settled = ["CLOSED", "DECLINED", "CANCELLED"].includes(String(row.status));
  const results = [
    F8_largeAdvance(facts, thresholds),
    F9_invoiceMismatch(facts),
    settled ? null : F12_deliveryOverdue(facts),
  ].filter((r): r is FlagResult => r !== null);

  await reconcile(tx, String(row.fest_id), "VENDOR_REQUEST", requestId, results);
  return results;
}

/** Open flags on an entity, worst first — what the endorsement and approval queues show. */
export async function openFlagsFor(tx: Tx, entityType: string, entityId: string) {
  return tx.select().from(flags)
    .where(and(
      eq(flags.entityType, entityType as "REIMBURSEMENT"),
      eq(flags.entityId, entityId),
      eq(flags.status, "OPEN"),
    ))
    .orderBy(sql`case severity when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`, flags.createdAt);
}
