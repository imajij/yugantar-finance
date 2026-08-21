import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { ApiError, parseBody, route } from "@/lib/api";
import { presignUpload, storageKey, validateUpload } from "@/lib/storage";

const schema = z.object({
  purpose: z.enum([
    "RECEIPT", "QUOTE", "LISTING", "PO", "INVOICE", "DELIVERY_PROOF",
    "PAYMENT_PROOF", "MOU", "TICKET_ATTACHMENT", "TICKET_PROOF", "OTHER",
  ]),
  file_name: z.string().min(1).max(255),
  mime_type: z.string().min(3).max(100),
  size_bytes: z.number().int().positive(),
  entity_type: z.string().optional(),
  entity_id: z.uuid().optional(),
});

/** PRD 20.2 step 1 — validates type and size against section 14 before handing out a URL. */
export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  try {
    validateUpload(b.mime_type, b.size_bytes);
  } catch (e) {
    throw new ApiError("VALIDATION_ERROR", (e as Error).message);
  }

  const [row] = await db.insert(attachments).values({
    festId: user.festId,
    purpose: b.purpose,
    kind: "FILE",
    storageKey: "pending",
    fileName: b.file_name,
    mimeType: b.mime_type,
    sizeBytes: b.size_bytes,
    uploadedBy: user.id,
  }).returning();

  const key = storageKey(user.festId, row.id, b.file_name);
  await db.update(attachments).set({ storageKey: key }).where(eq(attachments.id, row.id));
  const { uploadUrl } = await presignUpload(key);

  return { attachment_id: row.id, upload_url: uploadUrl, storage_key: key };
});
