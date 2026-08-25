import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { deleteMessage, editMessage } from "@/lib/services/chat";

const schema = z.object({ body: z.string().min(1).max(4000) });

/** Five minutes to correct a typo; after that, post a correction. */
export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return editMessage(user, params.id, b.body);
});

/** Soft: the row keeps its place and shows as removed rather than leaving a gap. */
export const DELETE = route<{ id: string }>(async ({ user, params }) =>
  deleteMessage(user, params.id));
