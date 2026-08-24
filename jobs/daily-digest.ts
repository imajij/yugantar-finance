/**
 * PRD 10 / 20.13 `/cron/daily-digest` — one message a day to Finance, Management,
 * and the HODs who opted in.
 *
 * The digest is the answer to "did anything need me yesterday that I missed?", so
 * it only ever contains things that are *still* outstanding: decisions waiting,
 * flags open, deliveries late, tickets past due. Nothing that has already been
 * dealt with appears, and a person with an empty digest gets no email at all —
 * a daily "nothing to report" is the fastest way to train someone to ignore it.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { notify } from "@/lib/services/notifications";
import { formatPaise } from "@/lib/money";
import { recordRun, type JobResult } from "./index";

interface DigestRow {
  fest_id: string;
  fest_name: string;
  pending_endorsements: number;
  pending_approvals: number;
  pending_payments: number;
  payable_paise: number;
  open_high_flags: number;
  open_flags: number;
  overdue_deliveries: number;
  overdue_pledges: number;
  untriaged_tickets: number;
  overdue_tickets: number;
  escalated_tickets: number;
}

/** One row per active fest, so a shared deployment digests each independently. */
async function digestFacts(): Promise<DigestRow[]> {
  return (await db.execute(sql`
    select f.id as fest_id, f.name as fest_name,
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = f.id and r.deleted_at is null and r.status = 'SUBMITTED')      as pending_endorsements,
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = f.id and r.deleted_at is null and r.status = 'HOD_ENDORSED')
      + (select count(*)::int from vendor_requests vr
        where vr.fest_id = f.id and vr.deleted_at is null
          and vr.status in ('SUBMITTED','DELIVERED'))                                    as pending_approvals,
      (select count(*)::int from reimbursement_requests r
        where r.fest_id = f.id and r.deleted_at is null and r.status = 'APPROVED')
      + (select count(*)::int from vendor_milestones m
           join vendor_requests vr on vr.id = m.vendor_request_id
         where vr.fest_id = f.id and vr.deleted_at is null and m.paid_at is null
           and ((m.kind = 'ADVANCE' and vr.status = 'APPROVED')
             or (m.kind <> 'ADVANCE' and vr.status = 'BALANCE_APPROVED')))                as pending_payments,
      (select coalesce(sum(r.amount_paise), 0)::bigint from reimbursement_requests r
        where r.fest_id = f.id and r.deleted_at is null and r.status = 'APPROVED')        as payable_paise,
      (select count(*)::int from flags fl
        where fl.fest_id = f.id and fl.status = 'OPEN' and fl.severity = 'HIGH')          as open_high_flags,
      (select count(*)::int from flags fl
        where fl.fest_id = f.id and fl.status = 'OPEN')                                   as open_flags,
      (select count(*)::int from vendor_requests vr
        where vr.fest_id = f.id and vr.deleted_at is null and vr.delivered_at is null
          and vr.expected_delivery_on < current_date
          and vr.status not in ('CLOSED','DECLINED','CANCELLED','DRAFT'))                 as overdue_deliveries,
      (select count(*)::int from income_entries e
        where e.fest_id = f.id and e.deleted_at is null
          and e.status in ('PLEDGED','PARTIALLY_RECEIVED') and e.pledged_on is not null
          and (current_date - e.pledged_on) >
              coalesce((f.settings->'flag_thresholds'->>'income_followup_days')::int, 30)) as overdue_pledges,
      (select count(*)::int from tickets t
        where t.fest_id = f.id and t.deleted_at is null and t.status = 'OPEN')            as untriaged_tickets,
      (select count(*)::int from tickets t
        where t.fest_id = f.id and t.deleted_at is null and t.due_at < now()
          and t.status not in ('CLOSED','REJECTED','CANCELLED'))                          as overdue_tickets,
      (select count(*)::int from tickets t
        where t.fest_id = f.id and t.deleted_at is null and t.escalated_at is not null
          and t.status not in ('CLOSED','REJECTED','CANCELLED'))                          as escalated_tickets
      from fests f
     where f.is_active
  `)) as unknown as DigestRow[];
}

/** Only the lines that have something in them; a digest of zeroes is not a digest. */
function linesFor(row: DigestRow): { label: string; value: string }[] {
  const candidates: [string, number, string?][] = [
    ["Waiting on an HOD endorsement", row.pending_endorsements],
    ["Waiting on Finance approval", row.pending_approvals],
    ["Waiting on a payment", row.pending_payments, formatPaise(Number(row.payable_paise))],
    ["Open high flags", row.open_high_flags],
    ["Open flags in total", row.open_flags],
    ["Deliveries past their date", row.overdue_deliveries],
    ["Pledges past the follow-up window", row.overdue_pledges],
    ["Tickets nobody has triaged", row.untriaged_tickets],
    ["Tickets past their due date", row.overdue_tickets],
    ["Escalated tickets", row.escalated_tickets],
  ];
  return candidates
    .filter(([, n]) => Number(n) > 0)
    .map(([label, n, extra]) => ({ label, value: extra ? `${n} · ${extra}` : String(n) }));
}

export async function runDailyDigest(): Promise<JobResult> {
  const rows = await digestFacts();
  let sent = 0;
  let skipped = 0;

  for (const row of rows) {
    const blocks = linesFor(row);
    if (blocks.length === 0) {
      skipped += 1;
      continue;
    }

    const urgent = Number(row.open_high_flags) + Number(row.escalated_tickets);
    await db.transaction(async (tx) => {
      // Finance and Management always; HODs only if they asked for it (PRD 10).
      const optedInHods = (await tx.execute(sql`
        select id from users
         where fest_id = ${row.fest_id} and status = 'ACTIVE'
           and role = 'DEPT_HOD' and digest_opt_in
      `)) as unknown as { id: string }[];

      sent += await notify(tx, {
        festId: row.fest_id,
        type: "digest.daily",
        entityType: "FEST",
        entityId: row.fest_id,
        title: urgent > 0
          ? `${row.fest_name}: ${urgent} thing${urgent === 1 ? "" : "s"} need attention today`
          : `${row.fest_name}: today's outstanding items`,
        body: "Everything below is still open. Anything already dealt with has been left out.",
        blocks,
        footnote: "Open the dashboard to work through these.",
        toRoles: ["FINANCE_HOD", "MANAGEMENT"],
        toUsers: optedInHods.map((u) => u.id),
      });
    });
  }

  const result = { fests: rows.length, notified: sent, quiet_fests: skipped };
  await recordRun("daily-digest", result);
  return result;
}
