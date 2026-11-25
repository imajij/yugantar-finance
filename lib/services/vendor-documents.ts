/**
 * Documents added after the fact — to a vendor request once it is raised, and to
 * a vendor itself (PRD 7.3, 20.7).
 *
 * A vendor request gathers paper as it goes: a revised invoice, a purchase order,
 * a delivery note. Those are added here, never removed once the request is
 * submitted (attachments.ts keeps removal to the editable states), and each
 * addition goes on the request's timeline so whoever reviewed it can see the set
 * grew. A vendor's own papers — the MoU, GST certificate, bank proof — live on the
 * vendor, and are seen only by those who see its bank details.
 *
 * Files are uploaded first (presign → PUT → complete) and bound here, in one
 * transaction with the audit event (18.2 rule 5).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { attachments } from "@/db/schema";
import { assertCan, type Actor } from "@/lib/authz";
import { resolveEntity } from "@/lib/entities";
import { bindAttachments, listFor } from "./attachments";
import { recordAudit } from "./audit";

export const VENDOR_REQUEST_DOCUMENT_KINDS = ["INVOICE", "QUOTE", "PO", "DELIVERY_PROOF", "OTHER"] as const;
export const VENDOR_DOCUMENT_KINDS = ["MOU", "INVOICE", "QUOTE", "OTHER"] as const;

export type VendorRequestDocumentKind = (typeof VENDOR_REQUEST_DOCUMENT_KINDS)[number];
export type VendorDocumentKind = (typeof VENDOR_DOCUMENT_KINDS)[number];

const NAMES: Record<string, string> = {
  INVOICE: "invoice", QUOTE: "quote", PO: "purchase order",
  DELIVERY_PROOF: "delivery proof", MOU: "MoU", OTHER: "document",
};

/** The timeline line: "Added RentInvoice.pdf (invoice)". */
function describe(names: string[], kind: string): string {
  return `Added ${names.join(", ")} (${NAMES[kind] ?? kind.toLowerCase()})`;
}

async function bindAs(
  actor: Actor,
  type: "VENDOR_REQUEST" | "VENDOR",
  entityId: string,
  attachmentIds: string[],
  kind: string,
  auditAction: string,
) {
  return db.transaction(async (tx) => {
    await bindAttachments(tx, actor, attachmentIds, type, entityId);
    const rows = await tx.update(attachments)
      .set({ purpose: kind as typeof attachments.$inferInsert.purpose })
      .where(and(inArray(attachments.id, attachmentIds), eq(attachments.festId, actor.festId)))
      .returning({ id: attachments.id, fileName: attachments.fileName });

    const names = rows.map((r) => r.fileName ?? "file");
    await recordAudit(tx, {
      festId: actor.festId, entityType: type, entityId, actorId: actor.id,
      action: auditAction,
      after: { files: names, purpose: kind },
      reason: describe(names, kind),
    });
    return { added: rows.length };
  });
}

export async function addVendorRequestDocuments(
  actor: Actor, requestId: string, input: { attachmentIds: string[]; kind: VendorRequestDocumentKind },
) {
  const resource = await resolveEntity(actor.festId, "VENDOR_REQUEST", requestId);
  assertCan(actor, "vendorRequest.document.add", resource);
  return bindAs(actor, "VENDOR_REQUEST", requestId, input.attachmentIds, input.kind, "vendor_request.document.add");
}

export async function addVendorDocuments(
  actor: Actor, vendorId: string, input: { attachmentIds: string[]; kind: VendorDocumentKind },
) {
  const resource = await resolveEntity(actor.festId, "VENDOR", vendorId);
  assertCan(actor, "vendor.document.manage", resource);
  return bindAs(actor, "VENDOR", vendorId, input.attachmentIds, input.kind, "vendor.document.add");
}

export async function listVendorDocuments(actor: Actor, vendorId: string) {
  const resource = await resolveEntity(actor.festId, "VENDOR", vendorId);
  assertCan(actor, "vendor.document.view", resource);
  const rows = await listFor("VENDOR", vendorId);
  return rows
    .filter((r) => r.storageKey && r.storageKey !== "pending")
    .map((r) => ({ id: r.id, fileName: r.fileName ?? "file", purpose: r.purpose, createdAt: r.createdAt }));
}
