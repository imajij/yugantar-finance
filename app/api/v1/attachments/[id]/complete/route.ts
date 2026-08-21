import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { ApiError, notFound, route } from "@/lib/api";
import { getObject, objectExists, sha256 } from "@/lib/storage";

/**
 * PRD 20.2 step 3 — verify the object landed, hash it for F1, and (v1.1) kick off OCR.
 * The sha256 is what makes duplicate detection exact rather than heuristic.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  const [row] = await db.select().from(attachments)
    .where(and(
      eq(attachments.id, params.id),
      eq(attachments.festId, user.festId),
      eq(attachments.uploadedBy, user.id),
    )).limit(1);
  if (!row) throw notFound("Attachment");
  if (!row.storageKey) throw new ApiError("VALIDATION_ERROR", "Links do not need completing");

  const meta = await objectExists(row.storageKey);
  if (!meta) throw new ApiError("VALIDATION_ERROR", "No file was uploaded to that URL");

  const body = await getObject(row.storageKey);
  const [updated] = await db.update(attachments)
    .set({ sha256: sha256(body), sizeBytes: meta.sizeBytes })
    .where(eq(attachments.id, row.id))
    .returning();

  // ponytail: phash and OCR are v1.1 (21.2); the columns exist so neither needs a migration.
  return updated;
});
