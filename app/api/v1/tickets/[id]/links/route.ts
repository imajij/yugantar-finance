import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { linkTicket } from "@/lib/services/tickets";

const schema = z.object({
  to_type: z.enum(["REIMBURSEMENT", "VENDOR_REQUEST", "TICKET"]),
  to_id: z.uuid(),
});

/**
 * PRD 20.9 — relate a ticket to the money it caused, or to a sibling ticket.
 * This is what lets the close-out report tie a spend back to the ask behind it.
 */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return linkTicket(user, params.id, b.to_type, b.to_id);
});
