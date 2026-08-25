import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { decideAllocationRequest } from "@/lib/services/allocations";

const schema = z.object({
  decision: z.enum(["APPROVE", "DECLINE"]),
  note: z.string().min(1).max(1000),
});

/**
 * Approving performs the transfer, in the same transaction. Both answers carry a
 * note, because the note is what the department actually reads.
 */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return decideAllocationRequest(user, params.id, b.decision, b.note);
});
