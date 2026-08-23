import { z } from "zod";
import { parseBody, parseQuery, route } from "@/lib/api";
import { createTicket, listTickets } from "@/lib/services/tickets";
import { TICKET_STATES } from "@/lib/state-machines/ticket";

const listQuery = z.object({
  scope: z.enum(["inbox", "outgoing", "mine", "all"]).default("inbox"),
  status: z.string().optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  overdue: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});

export const GET = route(async ({ user, request }) => {
  const f = parseQuery(request, listQuery);
  const status = f.status?.split(",").filter((s) => (TICKET_STATES as readonly string[]).includes(s));
  return {
    data: await listTickets(user, {
      scope: f.scope, status, priority: f.priority, overdue: f.overdue === "1", limit: f.limit,
    }),
    next_cursor: null,
  };
});

const createSchema = z.object({
  title: z.string().min(5).max(80),
  description: z.string().min(5).max(2000),
  target_department_id: z.uuid(),
  due_at: z.iso.datetime({ offset: true }).or(z.iso.date()),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).default("MEDIUM"),
  location: z.string().max(200).nullish(),
  estimated_cost_paise: z.number().int().min(0).nullish(),
  line_item_id: z.uuid().nullish(),
  watcher_ids: z.array(z.uuid()).max(10).optional(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, createSchema);
  return createTicket(user, {
    title: b.title, description: b.description, targetDepartmentId: b.target_department_id,
    dueAt: b.due_at, priority: b.priority, location: b.location,
    estimatedCostPaise: b.estimated_cost_paise, lineItemId: b.line_item_id, watcherIds: b.watcher_ids,
  });
}, { idempotent: true });
