import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { TICKET_ACTIONS } from "@/lib/state-machines/ticket";
import { transitionTicket } from "@/lib/services/tickets";

const schema = z.object({
  action: z.enum(TICKET_ACTIONS),
  reason: z.string().min(3).max(500).optional(),
  question: z.string().min(3).max(500).optional(),
  answer: z.string().min(1).max(500).optional(),
  assignee_id: z.uuid().optional(),
});

export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const { action, ...body } = await parseBody(request, schema);
  return transitionTicket(user, params.id, action, body);
}, { idempotent: true });
