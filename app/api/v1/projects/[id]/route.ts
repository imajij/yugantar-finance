import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { deleteProject, updateProject } from "@/lib/services/planning";

const schema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(2000).nullish(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"]).optional(),
  lead_id: z.uuid().nullish(),
  starts_on: z.iso.date().nullish(),
  ends_on: z.iso.date().nullish(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return updateProject(user, params.id, {
    name: b.name, description: b.description, status: b.status,
    leadId: b.lead_id, startsOn: b.starts_on, endsOn: b.ends_on,
  });
});

/** Soft. The tickets survive it and are simply unfiled — a project is not an owner. */
export const DELETE = route<{ id: string }>(async ({ user, params }) => deleteProject(user, params.id));
