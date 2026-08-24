import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { bulkApprove } from "@/lib/services/reimbursements";

const schema = z.object({ ids: z.array(z.uuid()).min(1).max(100) });

/**
 * PRD 20.6 — approve a batch. Anything carrying an open High flag is skipped and
 * says so; a High flag is there to force one person to look at one request (8.3).
 */
export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return bulkApprove(user, b.ids);
}, { idempotent: true });
