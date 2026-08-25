import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { deleteLabel, updateLabel } from "@/lib/services/planning";

const schema = z.object({
  name: z.string().min(2).max(40).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return updateLabel(user, params.id, b);
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => deleteLabel(user, params.id));
