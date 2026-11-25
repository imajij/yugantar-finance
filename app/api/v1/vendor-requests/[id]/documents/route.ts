import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { addVendorRequestDocuments, VENDOR_REQUEST_DOCUMENT_KINDS } from "@/lib/services/vendor-documents";

const schema = z.object({
  attachment_ids: z.array(z.uuid()).min(1).max(10),
  kind: z.enum(VENDOR_REQUEST_DOCUMENT_KINDS),
});

/** 7.3 — add documents to a vendor request after it was raised. `can` is checked in the service. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return addVendorRequestDocuments(user, params.id, { attachmentIds: b.attachment_ids, kind: b.kind });
});
