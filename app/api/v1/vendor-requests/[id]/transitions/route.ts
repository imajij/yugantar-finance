import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { VENDOR_ACTIONS } from "@/lib/state-machines/vendor";
import { transitionVendorRequest } from "@/lib/services/vendors";

const schema = z.object({
  action: z.enum(VENDOR_ACTIONS),
  reason: z.string().min(3).max(500).optional(),
  note: z.string().max(500).optional(),
  approved_value_paise: z.number().int().positive().optional(),
  milestone_id: z.uuid().optional(),
  paid_paise: z.number().int().positive().optional(),
  paid_at: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  payment_reference: z.string().min(3).max(80).optional(),
  proof_attachment_id: z.uuid().optional(),
  delivered_at: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  invoice_attachment_id: z.uuid().optional(),
  invoice_total_paise: z.number().int().positive().optional(),
  refund_expected_paise: z.number().int().min(0).optional(),
  amount_paise: z.number().int().positive().optional(),
  received_at: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  reference: z.string().max(80).optional(),
});

export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const { action, ...body } = await parseBody(request, schema);
  return transitionVendorRequest(user, params.id, action, body);
}, { idempotent: true });
