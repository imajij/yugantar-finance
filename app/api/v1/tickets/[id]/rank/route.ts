import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { reorderTicket } from "@/lib/services/tickets";

const schema = z.object({
  /** The card this one should sit under, and the one it should sit above. */
  after_id: z.uuid().nullish(),
  before_id: z.uuid().nullish(),
});

/**
 * Where a card sits in its column. Deliberately separate from the transition
 * endpoint: moving a card *within* a column is tidying, and moving it *between*
 * columns is a decision the state machine owns.
 */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return reorderTicket(user, params.id, { afterId: b.after_id, beforeId: b.before_id });
});
