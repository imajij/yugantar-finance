/**
 * Attachments (PRD 20.2, 11).
 *
 * The rule that shapes this file: **a file URL is only ever handed to someone who
 * can see the record it hangs off.** A presigned URL is a bearer token — whoever
 * holds it can fetch the receipt — so the permission check happens here, before
 * the URL exists, and the URL itself lives for fifteen minutes.
 *
 * Unbound attachments (uploaded, parent not created yet) belong to their uploader
 * and nobody else, which is what makes the "create with `attachment_ids`" flow in
 * 20.2 step 4 safe.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { attachments } from "@/db/schema";
import { ApiError, notFound } from "@/lib/api";
import { can } from "@/lib/authz";
import { VIEW_ACTION, resolveEntity, type EntityType } from "@/lib/entities";
import type { SessionUser } from "@/lib/session";
import { deleteObject, getObject, MAX_FILE_BYTES, objectExists, sha256, signedDownloadUrl } from "@/lib/storage";
import { canAttachToMessage, canSeeMessage } from "./chat";
import { recordAudit } from "./audit";

export type AttachmentRow = typeof attachments.$inferSelect;

/** PRD 14 — up to 5 per request, up to 10 per line item. */
export const MAX_PER_ENTITY: Partial<Record<EntityType, number>> = {
  REIMBURSEMENT: 5,
  LINE_ITEM: 10,
  VENDOR_REQUEST: 10,
  TICKET: 5,
  INCOME_ENTRY: 5,
  MESSAGE: 5,
};

async function load(actor: SessionUser, id: string, tx?: Tx): Promise<AttachmentRow> {
  const [row] = await (tx ?? db).select().from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.festId, actor.festId))).limit(1);
  if (!row) throw notFound("Attachment");
  return row;
}

/**
 * The single visibility gate. An attachment bound to a record inherits that
 * record's visibility; an unbound one is visible only to whoever uploaded it.
 */
export async function assertCanSee(actor: SessionUser, row: AttachmentRow): Promise<void> {
  if (!row.entityType || !row.entityId) {
    if (row.uploadedBy !== actor.id) {
      throw new ApiError("FORBIDDEN", "That file is not yours");
    }
    return;
  }

  // A message's audience is a membership row and the caller's own id, which is not
  // something a `Resource` can carry — so the chat service answers for its own.
  if (row.entityType === "MESSAGE") {
    if (!(await canSeeMessage(actor, row.entityId))) {
      throw new ApiError("FORBIDDEN", "You cannot see the channel this file was posted in");
    }
    return;
  }

  const type = row.entityType as EntityType;
  const resource = await resolveEntity(actor.festId, type, row.entityId);
  if (!can(actor, VIEW_ACTION[type], resource)) {
    throw new ApiError("FORBIDDEN", "You cannot see the record this file belongs to");
  }
}

/** Who may remove it: the uploader while the parent is still editable, plus H/F for line-item documents. */
async function assertCanRemove(actor: SessionUser, row: AttachmentRow): Promise<void> {
  await assertCanSee(actor, row);

  if (row.entityType === "LINE_ITEM" && row.entityId) {
    const resource = await resolveEntity(actor.festId, "LINE_ITEM", row.entityId);
    if (can(actor, "lineItem.document.manage", resource)) return;
  }

  if (row.uploadedBy !== actor.id) {
    throw new ApiError("FORBIDDEN", "Only the person who uploaded a file can remove it");
  }

  // A receipt behind an approved payment is part of the record now.
  if (row.entityType && row.entityId) {
    const resource = await resolveEntity(actor.festId, row.entityType as EntityType, row.entityId);
    const frozen = ["APPROVED", "PAID", "ON_HOLD", "CLOSED", "DECLINED", "BALANCE_APPROVED", "ADVANCE_PAID", "DELIVERED"];
    if (resource.status && frozen.includes(resource.status)) {
      throw new ApiError("VALIDATION_ERROR", `Files cannot be removed once the record is ${resource.status}`);
    }
  }
}

/**
 * PRD 20.2 step 3 — verify the object landed, hash it for F1, and (v1.1) kick off OCR.
 *
 * The sha256 is what makes F1's duplicate detection exact rather than heuristic, so
 * it is computed here from the bytes that actually arrived, not from anything the
 * client claimed. Only the uploader may complete their own upload: at this point the
 * attachment has no parent record for visibility to follow.
 */
export async function completeUpload(actor: SessionUser, id: string) {
  const row = await load(actor, id);
  if (row.uploadedBy !== actor.id) {
    throw new ApiError("FORBIDDEN", "That upload is not yours");
  }
  if (row.kind === "LINK") {
    throw new ApiError("VALIDATION_ERROR", "Links do not need completing");
  }
  if (!row.storageKey || row.storageKey === "pending") {
    throw new ApiError("VALIDATION_ERROR", "That attachment has no upload URL");
  }

  const meta = await objectExists(row.storageKey);
  if (!meta) throw new ApiError("VALIDATION_ERROR", "No file was uploaded to that URL");
  if (meta.sizeBytes > MAX_FILE_BYTES) {
    throw new ApiError("VALIDATION_ERROR", "That file is larger than the 10 MB limit");
  }

  const body = await getObject(row.storageKey);
  const [updated] = await db.update(attachments)
    .set({ sha256: sha256(body), sizeBytes: meta.sizeBytes })
    .where(eq(attachments.id, row.id))
    .returning();

  // ponytail: phash and OCR are v1.1 (21.2); the columns exist so neither needs a migration.
  return updated;
}

export async function getAttachment(actor: SessionUser, id: string) {
  const row = await load(actor, id);
  await assertCanSee(actor, row);
  return row;
}

/** 20.2 — a signed GET that expires in fifteen minutes. Never a public URL. */
export async function attachmentUrl(actor: SessionUser, id: string): Promise<{ url: string; expires_in: number }> {
  const row = await load(actor, id);
  await assertCanSee(actor, row);
  if (row.removedAt) throw notFound("Attachment");

  if (row.kind === "LINK") {
    if (!row.url) throw notFound("Attachment");
    return { url: row.url, expires_in: 0 };
  }
  if (!row.storageKey || row.storageKey === "pending") {
    throw new ApiError("VALIDATION_ERROR", "That upload was never completed");
  }
  return { url: await signedDownloadUrl(row.storageKey), expires_in: 15 * 60 };
}

export interface LinkInput {
  purpose: AttachmentRow["purpose"];
  url: string;
  label?: string | null;
  sourceName?: string | null;
  quotedAmountPaise?: number | null;
  entityType?: EntityType;
  entityId?: string;
}

/** 20.2 step 5 — a link (an online listing, a shared drive quote) skips the upload dance. */
export async function createLink(actor: SessionUser, input: LinkInput) {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new ApiError("VALIDATION_ERROR", "That is not a valid URL");
  }
  // A `javascript:` or `data:` "link" rendered as an anchor is an XSS vector.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ApiError("VALIDATION_ERROR", "Links must be http or https");
  }

  if (input.entityType && input.entityId) {
    await assertCanAttachTo(actor, input.entityType, input.entityId);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(attachments).values({
      festId: actor.festId,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      purpose: input.purpose,
      kind: "LINK",
      url: parsed.toString(),
      label: input.label ?? null,
      sourceName: input.sourceName ?? null,
      quotedAmountPaise: input.quotedAmountPaise ?? null,
      uploadedBy: actor.id,
    }).returning();

    if (input.entityType && input.entityId) {
      await recordAudit(tx, {
        festId: actor.festId, entityType: input.entityType, entityId: input.entityId,
        actorId: actor.id, action: "attachment.link.add",
        after: { url: row.url, label: row.label, source_name: row.sourceName },
      });
    }
    return row;
  });
}

/** Attaching to a record requires being able to edit it, not merely see it. */
export async function assertCanAttachTo(actor: SessionUser, type: EntityType, id: string): Promise<void> {
  if (type === "MESSAGE") {
    if (!(await canAttachToMessage(actor, id))) {
      throw new ApiError("FORBIDDEN", "You can only attach files to your own message");
    }
    return;
  }
  const resource = await resolveEntity(actor.festId, type, id);
  const allowed =
    type === "LINE_ITEM" ? can(actor, "lineItem.document.manage", resource)
    : type === "REIMBURSEMENT" ? can(actor, "reimbursement.edit", resource) || resource.submitterId === actor.id
    : type === "VENDOR_REQUEST" ? can(actor, "vendorRequest.create", resource) || resource.submitterId === actor.id
    : type === "TICKET" ? can(actor, "ticket.view", resource)
    : type === "INCOME_ENTRY" ? can(actor, "income.manage", resource)
    : false;
  if (!allowed) throw new ApiError("FORBIDDEN", "You cannot attach files to that record");
}

export async function removeAttachment(actor: SessionUser, id: string) {
  const row = await load(actor, id);
  await assertCanRemove(actor, row);
  if (row.removedAt) return row;

  return db.transaction(async (tx) => {
    const [updated] = await tx.update(attachments)
      .set({ removedAt: new Date(), removedBy: actor.id })
      .where(eq(attachments.id, id))
      .returning();

    if (row.entityType && row.entityId) {
      await recordAudit(tx, {
        festId: actor.festId, entityType: row.entityType, entityId: row.entityId,
        actorId: actor.id, action: "attachment.remove",
        before: { file_name: row.fileName, label: row.label, url: row.url },
      });
    }
    return updated;
  });
}

/**
 * 20.2 step 4 — binds attachments the same user uploaded to a record being created.
 * Runs inside the creating transaction so a request never exists without its receipt.
 */
export async function bindAttachments(
  tx: Tx, actor: SessionUser, ids: string[], type: EntityType, entityId: string,
): Promise<number> {
  if (ids.length === 0) return 0;

  const max = MAX_PER_ENTITY[type];
  const [{ existing }] = (await tx.execute(sql`
    select count(*)::int as existing from attachments
     where entity_type = ${type} and entity_id = ${entityId} and removed_at is null
  `)) as unknown as { existing: number }[];
  if (max && existing + ids.length > max) {
    throw new ApiError("VALIDATION_ERROR", `At most ${max} files can be attached to a ${type.toLowerCase().replace("_", " ")}`);
  }

  const bound = await tx.update(attachments)
    .set({ entityType: type, entityId })
    .where(and(
      inArray(attachments.id, ids),
      eq(attachments.festId, actor.festId),
      // Only the uploader's own, still-unbound, still-live files.
      eq(attachments.uploadedBy, actor.id),
      isNull(attachments.entityId),
      isNull(attachments.removedAt),
    ))
    .returning({ id: attachments.id });

  if (bound.length !== ids.length) {
    throw new ApiError("VALIDATION_ERROR", "Some of those files were already used, removed, or are not yours");
  }
  return bound.length;
}

export async function listFor(type: EntityType, entityId: string, opts: { includeRemoved?: boolean } = {}, tx?: Tx) {
  return (tx ?? db).select().from(attachments)
    .where(and(
      eq(attachments.entityType, type),
      eq(attachments.entityId, entityId),
      opts.includeRemoved ? undefined : isNull(attachments.removedAt),
    ))
    .orderBy(asc(attachments.createdAt));
}

/**
 * 20.13 `/cron/gc-attachments` — an upload that never found a parent is dead weight
 * in a private bucket. Twenty-four hours is long enough for any create flow to finish.
 */
export async function collectOrphanedUploads(olderThanHours = 24): Promise<{ deleted: number }> {
  const orphans = await db.select({ id: attachments.id, storageKey: attachments.storageKey })
    .from(attachments)
    .where(and(
      isNull(attachments.entityId),
      isNull(attachments.removedAt),
      eq(attachments.kind, "FILE"),
      sql`${attachments.createdAt} < now() - make_interval(hours => ${olderThanHours})`,
    ))
    .limit(500);

  for (const o of orphans) {
    if (o.storageKey && o.storageKey !== "pending") await deleteObject(o.storageKey);
    await db.update(attachments)
      .set({ removedAt: new Date() })
      .where(eq(attachments.id, o.id));
  }
  return { deleted: orphans.length };
}
