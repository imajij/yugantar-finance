import { route } from "@/lib/api";
import { resendInvitation } from "@/lib/services/admin";

/**
 * Sends somebody's invitation again — the same message `POST /users` sends, not a
 * different one.
 *
 * The reason it exists: a segregated workflow deadlocks on an empty seat, and the
 * commonest reason a seat is empty is an invitation that went to spam. Before this,
 * the only way out was deleting the account and re-inviting, which loses the id
 * every audit row already points at.
 */
export const POST = route<{ id: string }>(async ({ user, params }) =>
  resendInvitation(user, params.id));
