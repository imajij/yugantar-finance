import { z } from "zod";
import { parseBody, parseQuery, route } from "@/lib/api";
import { addDocument, listDocuments } from "@/lib/services/line-items";

const query = z.object({ include_removed: z.enum(["0", "1"]).optional() });

/** PRD 20.5 — supporting documents. Removed ones are shown to Finance on request. */
export const GET = route<{ id: string }>(async ({ user, params, request }) => {
  const q = parseQuery(request, query);
  return listDocuments(user, params.id, { includeRemoved: q.include_removed === "1" });
});

const schema = z.object({
  kind: z.enum(["FILE", "LINK"]).optional(),
  attachment_id: z.uuid().optional(),
  url: z.string().max(2048).optional(),
  label: z.string().min(1).max(200),
  source_name: z.string().max(200).optional(),
  quoted_amount_paise: z.number().int().nonnegative().optional(),
  purpose: z.enum(["QUOTE", "LISTING", "OTHER"]).optional(),
});

/** PRD 20.5 — bind an uploaded file, or record a link. Re-evaluates F13 / F14. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return addDocument(user, params.id, {
    attachmentId: b.attachment_id,
    url: b.url,
    label: b.label,
    sourceName: b.source_name ?? null,
    quotedAmountPaise: b.quoted_amount_paise ?? null,
    purpose: b.purpose,
  });
});
