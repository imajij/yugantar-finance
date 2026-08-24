/**
 * PRD 20.13 `/cron/ticket-sla` — the clock on work tickets (7.7).
 *
 * Five things, in the order they can happen to one ticket:
 *   1. Nobody triaged it inside the SLA        → remind the target HOD
 *   2. Still nobody, a second interval later   → escalate to Management and the
 *                                                requesting HOD (7.7)
 *   3. Its due date passed                     → tell both HODs and the assignee
 *   4. Marked done, unconfirmed for 24 h       → remind the requester
 *   5. Still unconfirmed at 48 h               → auto-close it (21.4)
 *
 * SLA windows come from `fests.settings.ticket_sla_minutes` (19.5) and differ on
 * fest days, when "urgent" means half an hour rather than two.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { notify } from "@/lib/services/notifications";
import { recordAudit } from "@/lib/services/audit";
import { recordRun, type JobResult } from "./index";

type Row = Record<string, string>;

/**
 * Minutes allowed before a ticket of each priority counts as un-triaged. On a fest
 * day the whole table tightens — that is the difference between a platform people
 * use during the fest and one they abandon for WhatsApp.
 */
const SLA_MINUTES = sql`
  coalesce(
    (f.settings->'ticket_sla_minutes'->t.priority::text->>
      (case when current_date::text = any(
              coalesce(array(select jsonb_array_elements_text(f.settings->'fest_days')), '{}'::text[]))
            then 'fest' else 'other' end))::int,
    case t.priority when 'URGENT' then 30 when 'HIGH' then 120 when 'MEDIUM' then 1440 else 4320 end
  )
`;

export async function runTicketSla(): Promise<JobResult> {
  const result = await db.transaction(async (tx) => {
    /* 1 — triage reminder */
    const untriaged = (await tx.execute(sql`
      update tickets t set triage_reminded_at = now()
        from fests f
       where f.id = t.fest_id
         and t.deleted_at is null and t.status = 'OPEN'
         and t.triage_reminded_at is null
         and t.created_at < now() - make_interval(mins => ${SLA_MINUTES})
      returning t.id, t.fest_id, t.human_id, t.title, t.target_department_id, t.priority
    `)) as unknown as Row[];

    for (const t of untriaged) {
      await notify(tx, {
        festId: t.fest_id, type: "ticket.triage_overdue", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} still needs triage`,
        body: t.title,
        blocks: [{ label: "Priority", value: t.priority }],
        footnote: "Waiting on: the target department's HOD, to accept or reject",
        toDepartmentHods: [t.target_department_id],
      });
    }

    /* 2 — second interval: escalate (7.7) */
    const escalated = (await tx.execute(sql`
      update tickets t set triage_escalated_at = now(), escalated_at = coalesce(t.escalated_at, now())
        from fests f
       where f.id = t.fest_id
         and t.deleted_at is null and t.status = 'OPEN'
         and t.triage_reminded_at is not null and t.triage_escalated_at is null
         and t.created_at < now() - make_interval(mins => ${SLA_MINUTES} * 2)
      returning t.id, t.fest_id, t.human_id, t.title,
                t.target_department_id, t.requesting_department_id, t.priority
    `)) as unknown as Row[];

    for (const t of escalated) {
      await notify(tx, {
        festId: t.fest_id, type: "ticket.escalated", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} has gone untriaged twice over`,
        body: t.title,
        blocks: [{ label: "Priority", value: t.priority }],
        footnote: "Waiting on: Management, to unblock it",
        toDepartmentHods: [t.target_department_id, t.requesting_department_id],
        toRoles: ["MANAGEMENT"],
      });
      await recordAudit(tx, {
        festId: t.fest_id, entityType: "TICKET", entityId: t.id, actorId: null,
        action: "ticket.auto_escalate", reason: "No triage within twice the SLA window",
      });
    }

    /* 3 — due date passed */
    const overdue = (await tx.execute(sql`
      update tickets t set due_reminded_at = now()
       where t.deleted_at is null
         and t.status not in ('CLOSED','REJECTED','CANCELLED','DONE')
         and t.due_reminded_at is null
         and t.due_at < now()
      returning t.id, t.fest_id, t.human_id, t.title, t.assignee_id,
                t.target_department_id, t.requesting_department_id
    `)) as unknown as Row[];

    for (const t of overdue) {
      await notify(tx, {
        festId: t.fest_id, type: "ticket.due_passed", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} has passed its due date`,
        body: t.title,
        footnote: "Waiting on: the assignee, or a new due date from the HOD",
        toUsers: t.assignee_id ? [t.assignee_id] : [],
        toDepartmentHods: [t.target_department_id, t.requesting_department_id],
      });
    }

    /* 4 — done, awaiting confirmation */
    const unconfirmed = (await tx.execute(sql`
      update tickets t set done_reminded_at = now()
        from fests f
       where f.id = t.fest_id
         and t.deleted_at is null and t.status = 'DONE'
         and t.done_reminded_at is null
         and t.done_at < now() - make_interval(
               hours => coalesce((f.settings->>'ticket_done_reminder_hours')::int, 24))
      returning t.id, t.fest_id, t.human_id, t.title, t.requester_id
    `)) as unknown as Row[];

    for (const t of unconfirmed) {
      await notify(tx, {
        festId: t.fest_id, type: "ticket.confirm_overdue", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} is done and waiting on you`,
        body: t.title,
        footnote: "Waiting on: you, to confirm or reopen. It closes itself in 24 hours.",
        toUsers: [t.requester_id],
      });
    }

    /* 5 — auto-close at 48 h (21.4) */
    const closed = (await tx.execute(sql`
      update tickets t
         set status = 'CLOSED', closed_at = now(), auto_closed_at = now()
        from fests f
       where f.id = t.fest_id
         and t.deleted_at is null and t.status = 'DONE'
         and t.done_at < now() - make_interval(
               hours => coalesce((f.settings->>'ticket_auto_close_hours')::int, 48))
      returning t.id, t.fest_id, t.human_id, t.title, t.requester_id, t.assignee_id
    `)) as unknown as Row[];

    for (const t of closed) {
      await recordAudit(tx, {
        festId: t.fest_id, entityType: "TICKET", entityId: t.id, actorId: null,
        action: "ticket.transition.AUTO_CLOSE",
        before: { status: "DONE" }, after: { status: "CLOSED" },
        reason: "Nobody confirmed within the auto-close window",
      });
      await notify(tx, {
        festId: t.fest_id, type: "ticket.auto_closed", entityType: "TICKET", entityId: t.id,
        title: `${t.human_id} closed itself`,
        body: `${t.title} — nobody confirmed it, so it was closed automatically. Reopen it if that is wrong.`,
        toUsers: [t.requester_id, ...(t.assignee_id ? [t.assignee_id] : [])],
        inAppOnly: true,
      });
    }

    return {
      triage_reminders: untriaged.length,
      escalations: escalated.length,
      due_notices: overdue.length,
      confirmation_reminders: unconfirmed.length,
      auto_closed: closed.length,
    };
  });

  await recordRun("ticket-sla", result);
  return result;
}
