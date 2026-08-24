import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { createLink } from "@/lib/services/attachments";

const schema = z.object({
  kind: z.literal("LINK"),
  purpose: z.enum([
    "RECEIPT", "QUOTE", "LISTING", "PO", "INVOICE", "DELIVERY_PROOF",
    "PAYMENT_PROOF", "MOU", "TICKET_ATTACHMENT", "TICKET_PROOF", "OTHER",
  ]),
  url: z.string().min(1).max(2048),
  label: z.string().max(200).optional(),
  source_name: z.string().max(200).optional(),
  quoted_amount_paise: z.number().int().nonnegative().optional(),
  entity_type: z.enum(["REIMBURSEMENT", "VENDOR_REQUEST", "TICKET", "LINE_ITEM", "INCOME_ENTRY"]).optional(),
  entity_id: z.uuid().optional(),
});

/** PRD 20.2 step 5 — a link attachment: an online listing or a shared-drive quote. */
export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createLink(user, {
    purpose: b.purpose,
    url: b.url,
    label: b.label ?? null,
    sourceName: b.source_name ?? null,
    quotedAmountPaise: b.quoted_amount_paise ?? null,
    entityType: b.entity_type,
    entityId: b.entity_id,
  });
});
