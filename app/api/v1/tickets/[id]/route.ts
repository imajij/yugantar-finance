import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getTicketDetail, updateTicket } from "@/lib/services/tickets";

export const GET = route<{ id: string }>(async ({ user, params }) => getTicketDetail(user, params.id));

const patch = z.object({
  title: z.string().min(4).max(80).optional(),
  description: z.string().min(5).max(2000).optional(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  due_at: z.iso.datetime().optional(),
  assignee_id: z.uuid().nullable().optional(),
  location: z.string().max(200).nullable().optional(),
  estimated_cost_paise: z.number().int().nonnegative().nullable().optional(),
  label_ids: z.array(z.uuid()).max(10).optional(),
  project_id: z.uuid().nullable().optional(),
  cycle_id: z.uuid().nullable().optional(),
  parent_id: z.uuid().nullable().optional(),
});

/**
 * PRD 20.9 — the requester rewords it while it is still OPEN or NEEDS_INFO; the
 * target HOD retriages priority, due date, assignee and location at any point;
 * anyone on the ticket files it under a label, project, cycle or parent.
 */
export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, patch);
  return updateTicket(user, params.id, {
    title: b.title,
    description: b.description,
    priority: b.priority,
    dueAt: b.due_at,
    assigneeId: b.assignee_id,
    location: b.location,
    estimatedCostPaise: b.estimated_cost_paise,
    labelIds: b.label_ids,
    projectId: b.project_id,
    cycleId: b.cycle_id,
    parentId: b.parent_id,
  });
});
