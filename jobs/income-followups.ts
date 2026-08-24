/**
 * PRD 20.13 `/cron/income-followups` — pledges that have gone unreceived past the
 * fest's `income_followup_days` window (19.5, default 30).
 *
 * A pledge is not money. The gap between "sponsor said yes" and "sponsor paid" is
 * where a fest's cash position quietly goes wrong, and section 16's "vendor balances
 * unknown at fest close: 0" has an income twin. One reminder per pledge, then it
 * lives on the income screen's overdue filter rather than in anyone's inbox.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { notify } from "@/lib/services/notifications";
import { recordRun, type JobResult } from "./index";

export async function runIncomeFollowups(): Promise<JobResult> {
  const result = await db.transaction(async (tx) => {
    const due = (await tx.execute(sql`
      update income_entries e set followup_reminded_at = now()
        from fests f
       where f.id = e.fest_id
         and e.deleted_at is null
         and e.status in ('PLEDGED','PARTIALLY_RECEIVED')
         and e.pledged_on is not null
         and e.followup_reminded_at is null
         and (current_date - e.pledged_on) >
             coalesce((f.settings->'flag_thresholds'->>'income_followup_days')::int, 30)
      returning e.id, e.fest_id, e.source_name, e.type, e.pledged_paise, e.pledged_on,
                e.owning_department_id,
                (current_date - e.pledged_on) as days_since,
                coalesce((select sum(amount_paise) from income_tranches t
                           where t.income_entry_id = e.id), 0) as received_paise
    `)) as unknown as Record<string, string>[];

    for (const row of due) {
      const outstanding = Number(row.pledged_paise) - Number(row.received_paise);
      await notify(tx, {
        festId: row.fest_id, type: "income.followup",
        entityType: "INCOME_ENTRY", entityId: row.id,
        title: `${row.source_name} pledged ${row.days_since} days ago and has not paid in full`,
        body: `${row.type.replaceAll("_", " ").toLowerCase()} — pledged ${row.pledged_on}`,
        blocks: [
          { label: "Pledged", value: `₹${(Number(row.pledged_paise) / 100).toFixed(2)}` },
          { label: "Received", value: `₹${(Number(row.received_paise) / 100).toFixed(2)}` },
          { label: "Outstanding", value: `₹${(outstanding / 100).toFixed(2)}` },
        ],
        footnote: "Waiting on: Finance, to chase the sponsor or write the pledge off",
        toRoles: ["FINANCE_HOD"],
        toDepartmentHods: row.owning_department_id ? [row.owning_department_id] : [],
      });
    }

    return { reminded: due.length };
  });

  await recordRun("income-followups", result);
  return result;
}
