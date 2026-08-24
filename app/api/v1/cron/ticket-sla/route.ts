import { cronRoute } from "@/lib/cron";
import { runTicketSla } from "@/jobs/ticket-sla";

/** PRD 20.13 — triage reminders, escalation, due-date notices, auto-close. Every 5 minutes. */
export const { GET, POST } = cronRoute("ticket-sla", runTicketSla);
