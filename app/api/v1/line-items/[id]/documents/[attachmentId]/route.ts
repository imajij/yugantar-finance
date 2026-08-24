import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { removeDocument, updateDocument } from "@/lib/services/line-items";

const patch = z.object({
  label: z.string().min(1).max(200).optional(),
  source_name: z.string().max(200).nullable().optional(),
  quoted_amount_paise: z.number().int().nonnegative().nullable().optional(),
});

/** PRD 20.5 — correcting a label, source or quoted amount. Re-evaluates F14. */
export const PATCH = route<{ id: string; attachmentId: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, patch);
  return updateDocument(user, params.id, params.attachmentId, {
    label: b.label,
    sourceName: b.source_name,
    quotedAmountPaise: b.quoted_amount_paise,
  });
});

/** PRD 20.5 — soft remove; the file is retained and the removal is logged. */
export const DELETE = route<{ id: string; attachmentId: string }>(async ({ user, params }) =>
  removeDocument(user, params.id, params.attachmentId),
);
