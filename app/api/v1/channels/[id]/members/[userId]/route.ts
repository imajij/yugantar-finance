import { route } from "@/lib/api";
import { addMember, removeMember } from "@/lib/services/chat";

/**
 * The wall the whole feature rests on: somebody added to a department's channel has
 * to already be in that department. Enforced in the service, not here.
 */
export const POST = route<{ id: string; userId: string }>(async ({ user, params }) =>
  addMember(user, params.id, params.userId));

/** Leaving is your own to do; removing anyone else is managing the channel. */
export const DELETE = route<{ id: string; userId: string }>(async ({ user, params }) =>
  removeMember(user, params.id, params.userId));
