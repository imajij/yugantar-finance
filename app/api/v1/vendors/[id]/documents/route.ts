import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { addVendorDocuments, listVendorDocuments, VENDOR_DOCUMENT_KINDS } from "@/lib/services/vendor-documents";

/** 20.7 — a vendor's own papers. Seen by those who see its bank details. */
export const GET = route<{ id: string }>(async ({ user, params }) => listVendorDocuments(user, params.id));

const schema = z.object({
  attachment_ids: z.array(z.uuid()).min(1).max(10),
  kind: z.enum(VENDOR_DOCUMENT_KINDS),
});

export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return addVendorDocuments(user, params.id, { attachmentIds: b.attachment_ids, kind: b.kind });
});
