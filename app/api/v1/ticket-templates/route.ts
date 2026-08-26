import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { createTemplate, listTemplates } from "@/lib/services/planning";

/**
 * Templates are fest-wide and shared, like labels. The list is filtered to what the
 * caller could actually raise — a Member sees only templates addressed to their own
 * department, because those are the only tickets they may open.
 */
export const GET = route(async ({ user, request }) => ({
  data: await listTemplates(user, {
    all: new URL(request.url).searchParams.get("all") === "1",
  }),
}));

const schema = z.object({
  name: z.string().min(2).max(60),
  summary: z.string().max(200).nullish(),
  target_department_id: z.uuid().nullish(),
  title: z.string().max(80).nullish(),
  body: z.string().max(2000).nullish(),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).optional(),
  location: z.string().max(200).nullish(),
  estimated_cost_paise: z.number().int().min(0).nullish(),
  due_in_hours: z.number().int().min(1).max(8760).nullish(),
  project_id: z.uuid().nullish(),
  cycle_id: z.uuid().nullish(),
  label_ids: z.array(z.uuid()).max(10).optional(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createTemplate(user, {
    name: b.name, summary: b.summary, targetDepartmentId: b.target_department_id,
    title: b.title, body: b.body, priority: b.priority, location: b.location,
    estimatedCostPaise: b.estimated_cost_paise, dueInHours: b.due_in_hours,
    projectId: b.project_id, cycleId: b.cycle_id, labelIds: b.label_ids,
  });
});
