import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { createProject, listProjects } from "@/lib/services/planning";

/** A project groups tickets toward a deliverable — "Main stage build". */
export const GET = route(async ({ user }) => ({ data: await listProjects(user) }));

const schema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(2000).nullish(),
  status: z.enum(["PLANNED", "ACTIVE", "COMPLETED", "CANCELLED"]).optional(),
  lead_id: z.uuid().nullish(),
  starts_on: z.iso.date().nullish(),
  ends_on: z.iso.date().nullish(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createProject(user, {
    name: b.name, description: b.description, status: b.status,
    leadId: b.lead_id, startsOn: b.starts_on, endsOn: b.ends_on,
  });
});
