/**
 * PRD 20.13 `/cron/vendor-overdue` — F12 for expected delivery dates that have passed.
 *
 * "The date passed" needs no write to become true, so the flag rules would never
 * re-run on their own. This re-evaluates every request whose delivery is late and
 * lets `evaluateVendorFlags` reconcile: it opens F12 where it now fires and closes
 * it where the goods have since arrived.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { evaluateVendorFlags } from "@/lib/flags";
import { notify } from "@/lib/services/notifications";
import { recordRun, type JobResult } from "./index";

export async function runVendorOverdue(): Promise<JobResult> {
  const result = await db.transaction(async (tx) => {
    const overdue = (await tx.execute(sql`
      select vr.id, vr.fest_id, vr.human_id, vr.description, vr.department_id,
             vr.expected_delivery_on, v.name as vendor_name,
             (current_date - vr.expected_delivery_on) as days_late,
             exists (select 1 from flags f
                      where f.entity_type = 'VENDOR_REQUEST' and f.entity_id = vr.id
                        and f.rule = 'F12' and f.status = 'OPEN') as already_flagged
        from vendor_requests vr
        join vendors v on v.id = vr.vendor_id
       where vr.deleted_at is null
         and vr.delivered_at is null
         and vr.expected_delivery_on is not null
         and vr.expected_delivery_on < current_date
         and vr.status not in ('CLOSED','DECLINED','CANCELLED','DRAFT')
       limit 500
    `)) as unknown as Record<string, string | boolean>[];

    let notified = 0;
    for (const row of overdue) {
      await evaluateVendorFlags(tx, String(row.id));

      // Only the first time it goes late. F12 staying open is the ongoing signal;
      // a daily email about the same late delivery is how people learn to filter.
      if (!row.already_flagged) {
        notified += 1;
        await notify(tx, {
          festId: String(row.fest_id), type: "vendor.delivery_overdue",
          entityType: "VENDOR_REQUEST", entityId: String(row.id),
          title: `${row.human_id}: delivery is ${row.days_late} day(s) late`,
          body: String(row.description),
          blocks: [
            { label: "Vendor", value: String(row.vendor_name) },
            { label: "Expected", value: String(row.expected_delivery_on) },
          ],
          footnote: "Waiting on: the department, to chase the vendor or confirm delivery",
          toDepartmentHods: [String(row.department_id)],
          toRoles: ["FINANCE_HOD"],
        });
      }
    }

    // Deliveries that arrived since the last run: let the rules close F12.
    const arrived = (await tx.execute(sql`
      select vr.id from vendor_requests vr
        join flags f on f.entity_type = 'VENDOR_REQUEST' and f.entity_id = vr.id
                    and f.rule = 'F12' and f.status = 'OPEN'
       where vr.deleted_at is null and vr.delivered_at is not null
       limit 500
    `)) as unknown as { id: string }[];
    for (const row of arrived) await evaluateVendorFlags(tx, row.id);

    return { reevaluated: overdue.length, newly_flagged: notified, cleared: arrived.length };
  });

  await recordRun("vendor-overdue", result);
  return result;
}
