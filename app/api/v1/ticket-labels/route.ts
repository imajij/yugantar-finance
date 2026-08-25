import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { createLabel, listLabels } from "@/lib/services/planning";

/** Labels are fest-wide and shared: a tag Logistics made is one Tech can use. */
export const GET = route(async ({ user }) => ({ data: await listLabels(user) }));

const schema = z.object({
  name: z.string().min(2).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createLabel(user, { name: b.name, color: b.color });
});
