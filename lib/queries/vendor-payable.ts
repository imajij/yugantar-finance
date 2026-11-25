import { sql } from "drizzle-orm";

/**
 * When a vendor milestone is waiting on a payment, and how much. One definition,
 * read by the payment queue, its counts, the payment batch export and the digest,
 * with the milestone aliased `m` and its request `vr`.
 *
 * Payable: not settled, something still owed on it, and either
 *   - an advance on an APPROVED request, or a later milestone once the balance is
 *     released (7.3) — the first payment against each, or
 *   - already paid in part, at any open stage: an advance half-paid before delivery
 *     is still owed after it (0016_vendor_payments.sql).
 */
export const PAYABLE_MILESTONE = sql.raw(`(
  m.paid_at is null
  and m.planned_paise - coalesce(m.paid_paise, 0) > 0
  and (
    (m.kind = 'ADVANCE' and vr.status = 'APPROVED')
    or (m.kind <> 'ADVANCE' and vr.status = 'BALANCE_APPROVED')
    or (coalesce(m.paid_paise, 0) > 0
        and vr.status in ('APPROVED','ADVANCE_PAID','DELIVERED','BALANCE_APPROVED'))
  )
)`);

/** What is left to pay on it. */
export const OWED_ON_MILESTONE = sql.raw(`(m.planned_paise - coalesce(m.paid_paise, 0))`);
