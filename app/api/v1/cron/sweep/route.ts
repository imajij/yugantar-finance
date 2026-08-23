/**
 * PRD 11.4 — the nightly sweep. Some conditions become true because time passed,
 * not because anyone wrote a row: an overdue delivery, a stale request, a ticket
 * nobody triaged. This re-evaluates those and files reminders.
 *
 * Protected by a shared secret rather than a session — a cron runner has no user.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { errorResponse } from "@/lib/api";
import { evaluateVendorFlags } from "@/lib/flags";
import { notify } from "@/lib/services/notifications";

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return errorResponse("FORBIDDEN", "Cron secret missing or wrong");
  }

  const result = await db.transaction(async (tx) => {
    // F12: deliveries whose expected date has passed without a delivery.
    const overdue = (await tx.execute<{ id: string }>(sql`
      select id from vendor_requests
       where deleted_at is null
         and delivered_at is null
         and expected_delivery_on is not null
         and expected_delivery_on < current_date
         and status not in ('CLOSED','DECLINED','CANCELLED','DRAFT')
    `)) as unknown as { id: string }[];
    for (const row of overdue) await evaluateVendorFlags(tx, row.id);

    // Tickets nobody has triaged inside the fest's window.
    const untriaged = (await tx.execute<Record<string, string>>(sql`
      update tickets t
         set triage_reminded_at = now()
        from fests f
       where f.id = t.fest_id
         and t.deleted_at is null
         and t.status = 'OPEN'
         and t.triage_reminded_at is null
         and t.created_at < now() - make_interval(
               mins => coalesce((f.settings->>'ticket_triage_reminder_minutes')::int, 240))
      returning t.id, t.fest_id, t.human_id, t.title, t.target_department_id
    `)) as unknown as Record<string, string>[];

    for (const t of untriaged) {
      await notify(tx, {
        festId: t.fest_id, type: "ticket.triage_overdue", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} still needs triage`,
        body: t.title,
        toDepartmentHods: [t.target_department_id],
      });
    }

    // Work marked done that the requester has not confirmed.
    const unconfirmed = (await tx.execute<Record<string, string>>(sql`
      update tickets t
         set done_reminded_at = now()
        from fests f
       where f.id = t.fest_id
         and t.deleted_at is null
         and t.status = 'DONE'
         and t.done_reminded_at is null
         and t.done_at < now() - make_interval(
               hours => coalesce((f.settings->>'ticket_done_reminder_hours')::int, 24))
      returning t.id, t.fest_id, t.human_id, t.title, t.requester_id
    `)) as unknown as Record<string, string>[];

    for (const t of unconfirmed) {
      await notify(tx, {
        festId: t.fest_id, type: "ticket.confirm_overdue", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} is done and waiting on you`,
        body: t.title,
        toUsers: [t.requester_id],
      });
    }

    return {
      vendor_flags_reevaluated: overdue.length,
      triage_reminders: untriaged.length,
      confirmation_reminders: unconfirmed.length,
    };
  });

  return Response.json(result);
}
