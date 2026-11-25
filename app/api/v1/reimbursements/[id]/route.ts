import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getReimbursementDetail, updateReimbursement } from "@/lib/services/reimbursements";

export const GET = route<{ id: string }>(async ({ user, params }) =>
  getReimbursementDetail(user, params.id),
);

const patchSchema = z.object({
  line_item_id: z.uuid().optional(),
  expense_type_id: z.uuid().optional(),
  description: z.string().min(10).max(1000).optional(),
  transaction_on: z.iso.date().optional(),
  amount_paise: z.number().int().positive().optional(),
  merchant: z.string().max(120).nullish(),
  payee_name: z.string().min(2).max(120).optional(),
  payee_upi_id: z.string().regex(/^[\w.\-]{2,}@[a-zA-Z]{2,}$/).optional(),
  attachment_ids: z.array(z.uuid()).max(5).optional(),
  payment_proof_ids: z.array(z.uuid()).max(3).optional(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, patchSchema);
  return updateReimbursement(user, params.id, {
    lineItemId: b.line_item_id,
    expenseTypeId: b.expense_type_id,
    description: b.description,
    transactionOn: b.transaction_on,
    amountPaise: b.amount_paise,
    merchant: b.merchant,
    payeeName: b.payee_name,
    payeeUpiId: b.payee_upi_id,
    attachmentIds: b.attachment_ids,
    paymentProofIds: b.payment_proof_ids,
  });
});
