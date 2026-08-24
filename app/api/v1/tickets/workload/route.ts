import { route } from "@/lib/api";
import { ticketWorkload } from "@/lib/services/tickets";

/** PRD 20.9 — counts by department × priority × status, plus overdue and escalated. */
export const GET = route(({ user }) => ticketWorkload(user));
