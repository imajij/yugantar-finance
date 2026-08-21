import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { REIMBURSEMENT_ACTIONS } from "@/lib/state-machines/reimbursement";
import { transitionReimbursement } from "@/lib/services/reimbursements";

const schema = z.object({
  action: z.enum(REIMBURSEMENT_ACTIONS),
  reason: z.string().min(3).max(500).optional(),
  note: z.string().min(3).max(500).optional(),
  approval_note: z.string().min(3).max(500).optional(),
  payment_reference: z.string().min(3).max(80).optional(),
  paid_at: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  proof_attachment_id: z.uuid().optional(),
});

/** PRD 20.1 — role, state machine, segregation, required fields, audit, flags, then respond. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const { action, ...body } = await parseBody(request, schema);
  return transitionReimbursement(user, params.id, action, body);
}, { idempotent: true });
