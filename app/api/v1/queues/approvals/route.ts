import { route } from "@/lib/api";
import { approvalQueue } from "@/lib/queries/queues";

/**
 * PRD 20.11 — Finance's queue: endorsed reimbursements, submitted vendor requests,
 * and delivered requests waiting on a balance release. One list, flagged first.
 */
export const GET = route(async ({ user }) => ({ data: await approvalQueue(user), next_cursor: null }));
