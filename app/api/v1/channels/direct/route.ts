import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { directCandidates, openDirect } from "@/lib/services/chat";

/** Everyone you could start a conversation with. */
export const GET = route(async ({ user }) => ({ data: await directCandidates(user) }));

const schema = z.object({ user_id: z.uuid() });

/**
 * Opens the conversation with somebody, or returns the one that already exists —
 * the pair is keyed on both ids sorted, so this is idempotent by construction.
 */
export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return openDirect(user, b.user_id);
});
