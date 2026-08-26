import { route } from "@/lib/api";
import { unlinkTicket } from "@/lib/services/tickets";

/**
 * Either end may remove a relation. "You are blocking us" is a claim about two
 * tickets, and the department on the receiving end has as much standing to
 * disagree with it as the one that made it.
 */
export const DELETE = route<{ id: string; linkId: string }>(async ({ user, params }) =>
  unlinkTicket(user, params.id, params.linkId));
