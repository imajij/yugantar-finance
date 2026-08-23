import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { editComment } from "@/lib/services/comments";

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, z.object({ body: z.string().min(1).max(2000) }));
  return editComment(user, params.id, b.body);
});
