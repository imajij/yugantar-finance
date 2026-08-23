import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { recordTranche } from "@/lib/services/income";

const schema = z.object({
  amount_paise: z.number().int().positive(),
  received_on: z.iso.date(),
  reference: z.string().max(80).nullish(),
});

/** PRD 20.8 — recording money moves the entry to PARTIALLY_RECEIVED or RECEIVED. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return recordTranche(user, params.id, {
    amountPaise: b.amount_paise, receivedOn: b.received_on, reference: b.reference,
  });
}, { idempotent: true });
