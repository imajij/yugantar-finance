import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { retireTemplate, updateTemplate } from "@/lib/services/planning";

const schema = z.object({
  name: z.string().min(2).max(60).optional(),
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

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return updateTemplate(user, params.id, {
    name: b.name, summary: b.summary, targetDepartmentId: b.target_department_id,
    title: b.title, body: b.body, priority: b.priority, location: b.location,
    estimatedCostPaise: b.estimated_cost_paise, dueInHours: b.due_in_hours,
    projectId: b.project_id, cycleId: b.cycle_id, labelIds: b.label_ids,
  });
});

/**
 * Retire, not delete — and it toggles, so a template retired by mistake comes back.
 * The tickets it shaped are in the record, and so is it.
 */
export const DELETE = route<{ id: string }>(async ({ user, params }) => retireTemplate(user, params.id));
