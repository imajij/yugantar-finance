/**
 * Reimbursements (PRD 7.2, 20.6). One transaction per write, audit event inside it,
 * flags re-evaluated after every state change (8.3).
 *
 * Special routing (7.2 / 5.2) lives in `landingStateForSubmit` and `approverRoleFor`,
 * not in branches here: an HOD's own request skips endorsement, and a Finance HOD's
 * own request is approved by Management.
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  attachments, auditEvents, comments, flags, lineItems, reimbursementRequests, users,
} from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, can, satisfiesActorConstraints, type Actor } from "@/lib/authz";
import { nextHumanId } from "@/lib/human-id";
import {
  approverRoleFor, assertReimbursementTransition, landingStateForSubmit,
  type ReimbursementAction, type ReimbursementState,
} from "@/lib/state-machines/reimbursement";
import { evaluateReimbursementFlags } from "@/lib/flags";
import { recordAudit, snapshot } from "./audit";

const AUDITED = [
  "status", "amountPaise", "lineItemId", "expenseTypeId", "description", "transactionOn",
  "payeeName", "payeeUpiId", "merchant", "version", "paymentReference",
] as const;

export interface CreateInput {
  lineItemId: string;
  expenseTypeId: string;
  description: string;
  transactionOn: string;
  amountPaise: number;
  merchant?: string | null;
  payeeName: string;
  payeeUpiId: string;
  attachmentIds: string[];
  submit?: boolean;
}

export async function createReimbursement(actor: Actor, input: CreateInput) {
  assertCan(actor, "reimbursement.create", { festId: actor.festId });
  if (input.attachmentIds.length === 0) {
    throw new ApiError("VALIDATION_ERROR", "At least one receipt is required");
  }

  return db.transaction(async (tx) => {
    const item = await loadOpenLineItem(tx, actor, input.lineItemId);
    await assertDocumentThreshold(tx, actor.festId, item.id, item.plannedPaise);

    const humanId = await nextHumanId(tx, actor.festId, "RB");
    const status: ReimbursementState = input.submit ? landingStateForSubmit(actor.role) : "DRAFT";

    const [row] = await tx.insert(reimbursementRequests).values({
      festId: actor.festId,
      humanId,
      departmentId: item.departmentId,
      lineItemId: item.id,
      expenseTypeId: input.expenseTypeId,
      submitterId: actor.id,
      description: input.description,
      transactionOn: input.transactionOn,
      amountPaise: input.amountPaise,
      merchant: input.merchant ?? null,
      payeeName: input.payeeName,
      payeeUpiId: input.payeeUpiId,
      status,
      submittedAt: input.submit ? new Date() : null,
    }).returning();

    await bindReceipts(tx, actor, row.id, input.attachmentIds);

    await recordAudit(tx, {
      festId: actor.festId, entityType: "REIMBURSEMENT", entityId: row.id, actorId: actor.id,
      action: input.submit ? "reimbursement.submit" : "reimbursement.create",
      after: snapshot(row, AUDITED),
    });

    if (input.submit) await evaluateReimbursementFlags(tx, row.id);
    return row;
  });
}

export interface UpdateInput extends Partial<Omit<CreateInput, "submit" | "attachmentIds">> {
  attachmentIds?: string[];
}

/** 7.2 — editable only by the submitter, only in DRAFT or SENT_BACK; a resubmission bumps `version`. */
export async function updateReimbursement(actor: Actor, id: string, input: UpdateInput) {
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);
    assertCan(actor, "reimbursement.edit", {
      festId: actor.festId, departmentId: before.departmentId,
      submitterId: before.submitterId, status: before.status,
    });

    if (input.lineItemId && input.lineItemId !== before.lineItemId) {
      const item = await loadOpenLineItem(tx, actor, input.lineItemId);
      await assertDocumentThreshold(tx, actor.festId, item.id, item.plannedPaise);
    }

    const [after] = await tx.update(reimbursementRequests).set({
      ...(input.lineItemId !== undefined ? { lineItemId: input.lineItemId } : {}),
      ...(input.expenseTypeId !== undefined ? { expenseTypeId: input.expenseTypeId } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.transactionOn !== undefined ? { transactionOn: input.transactionOn } : {}),
      ...(input.amountPaise !== undefined ? { amountPaise: input.amountPaise } : {}),
      ...(input.merchant !== undefined ? { merchant: input.merchant } : {}),
      ...(input.payeeName !== undefined ? { payeeName: input.payeeName } : {}),
      ...(input.payeeUpiId !== undefined ? { payeeUpiId: input.payeeUpiId } : {}),
      updatedAt: new Date(),
    }).where(eq(reimbursementRequests.id, id)).returning();

    if (input.attachmentIds?.length) await bindReceipts(tx, actor, id, input.attachmentIds);

    await recordAudit(tx, {
      festId: actor.festId, entityType: "REIMBURSEMENT", entityId: id, actorId: actor.id,
      action: "reimbursement.update",
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
    });
    await evaluateReimbursementFlags(tx, id);
    return after;
  });
}

export interface TransitionBody {
  reason?: string;
  note?: string;
  approval_note?: string;
  payment_reference?: string;
  paid_at?: string;
  proof_attachment_id?: string;
}

export async function transitionReimbursement(
  actor: Actor, id: string, action: ReimbursementAction, body: TransitionBody = {},
) {
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);
    const submitter = await loadSubmitter(tx, before.submitterId);

    const resource = {
      festId: actor.festId,
      departmentId: before.departmentId,
      targetDepartmentId: before.departmentId,
      submitterId: before.submitterId,
      submitterRole: submitter.role,
      status: before.status,
    };

    // Role and state come from the table; who exactly, from the actor constraints (5.2).
    const transition = assertReimbursementTransition(before.status, action, actor.role, body as Record<string, unknown>);
    if (!satisfiesActorConstraints(transition.actor, actor, resource)) {
      throw new ApiError("FORBIDDEN", `You may not ${action} this request`);
    }
    assertActionPermission(actor, action, resource);

    // 8.3 — approving over an open High flag needs an acknowledgement note.
    if (action === "APPROVE") {
      const open = await openHighFlags(tx, id);
      if (open.length > 0 && !body.approval_note) {
        throw new ApiError("VALIDATION_ERROR",
          `This request has ${open.length} open High flag${open.length === 1 ? "" : "s"}; an acknowledgement note is required`,
          { flags: open.map((f) => ({ rule: f.rule, explanation: f.explanation })) });
      }
    }

    const to = resolveTarget(before, action, submitter.role);
    const now = new Date();
    const reason = body.reason ?? body.note ?? null;

    const [after] = await tx.update(reimbursementRequests).set({
      status: to,
      updatedAt: now,
      ...(action === "SUBMIT" || action === "RESUBMIT" ? { submittedAt: now } : {}),
      ...(action === "RESUBMIT" ? { version: before.version + 1 } : {}),
      ...(action === "ENDORSE" ? { endorsedBy: actor.id, endorsedAt: now } : {}),
      ...(action === "APPROVE" ? { approvedBy: actor.id, approvedAt: now, approvalNote: body.approval_note ?? null } : {}),
      ...(action === "RECORD_PAYMENT"
        ? { paidBy: actor.id, paidAt: new Date(body.paid_at!), paymentReference: body.payment_reference! }
        : {}),
      ...(action === "SEND_BACK" ? { sendBackCount: before.sendBackCount + 1 } : {}),
      ...(reason !== null ? { lastReason: reason } : {}),
    }).where(and(
      eq(reimbursementRequests.id, id),
      eq(reimbursementRequests.status, before.status),   // optimistic guard against a concurrent transition
    )).returning();

    if (!after) throw conflict("This request changed while you were looking at it");

    if (action === "RECORD_PAYMENT" && body.proof_attachment_id) {
      await bindAttachment(tx, actor, body.proof_attachment_id, "REIMBURSEMENT", id, "PAYMENT_PROOF");
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "REIMBURSEMENT", entityId: id, actorId: actor.id,
      action: `reimbursement.transition.${action}`,
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED), reason,
    });

    await evaluateReimbursementFlags(tx, id);
    return after;
  });
}

/**
 * `can` is the authority on who may act; the transition table is the authority on
 * what may happen. Both must agree, so the approve/pay actions re-check here.
 */
function assertActionPermission(
  actor: Actor, action: ReimbursementAction,
  resource: { festId: string; departmentId: string; submitterId: string; submitterRole: Actor["role"]; status: string },
) {
  if (action === "ENDORSE") assertCan(actor, "reimbursement.endorse", resource);
  if (action === "APPROVE") assertCan(actor, "reimbursement.approve", resource);
  if (action === "RECORD_PAYMENT") assertCan(actor, "reimbursement.recordPayment", resource);
  if (action === "HOLD") assertCan(actor, "reimbursement.hold", resource);
}

/** SUBMIT and RESUBMIT land differently for an HOD (7.2 special routing). */
function resolveTarget(
  row: { status: ReimbursementState }, action: ReimbursementAction, submitterRole: Actor["role"],
): ReimbursementState {
  if (action === "SUBMIT" || action === "RESUBMIT") return landingStateForSubmit(submitterRole);
  const map: Partial<Record<ReimbursementAction, ReimbursementState>> = {
    ENDORSE: "HOD_ENDORSED", SEND_BACK: "SENT_BACK", DECLINE: "DECLINED",
    APPROVE: "APPROVED", HOLD: "ON_HOLD", RESOLVE_HOLD: "APPROVED",
    RECORD_PAYMENT: "PAID", WITHDRAW: "WITHDRAWN",
  };
  const to = map[action];
  if (!to) throw new ApiError("INVALID_TRANSITION", `No target state for ${action}`);
  return to;
}

/** Exported so the approval queue can label who the request is waiting on. */
export function waitingOn(status: ReimbursementState, submitterRole: Actor["role"]): string {
  switch (status) {
    case "SUBMITTED": return "Department HOD";
    case "HOD_ENDORSED": return approverRoleFor(submitterRole) === "MANAGEMENT" ? "Management" : "Finance HOD";
    case "APPROVED": return "Management";
    case "ON_HOLD": return "Finance HOD";
    case "SENT_BACK": case "DRAFT": return "Submitter";
    default: return "—";
  }
}

async function load(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(reimbursementRequests)
    .where(and(
      eq(reimbursementRequests.id, id),
      eq(reimbursementRequests.festId, actor.festId),
      isNull(reimbursementRequests.deletedAt),
    )).limit(1);
  if (!row) throw notFound("Request");
  assertCan(actor, "reimbursement.view", {
    festId: actor.festId, departmentId: row.departmentId, submitterId: row.submitterId,
  });
  return row;
}

async function loadSubmitter(tx: Tx, id: string) {
  const [row] = await tx.select({ id: users.id, role: users.role, name: users.name, departmentId: users.departmentId })
    .from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw notFound("Submitter");
  return row;
}

async function loadOpenLineItem(tx: Tx, actor: Actor, lineItemId: string) {
  const [item] = await tx.select().from(lineItems)
    .where(and(eq(lineItems.id, lineItemId), eq(lineItems.festId, actor.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!item) throw notFound("Line item");
  if (item.status === "CLOSED") {
    throw new ApiError("VALIDATION_ERROR", `${item.name} is closed; no new requests can attach to it`);
  }
  // A Member may only spend against their own department (5.1).
  if (!can(actor, "lineItem.view", { festId: actor.festId, departmentId: item.departmentId })) {
    throw new ApiError("FORBIDDEN", "That line item belongs to another department");
  }
  return item;
}

/**
 * 7.1 — at or above `line_item_doc_threshold_paise` a line item needs at least one
 * supporting document before requests can attach to it. This is a hard block (21.4).
 */
async function assertDocumentThreshold(tx: Tx, festId: string, lineItemId: string, plannedPaise: number) {
  const [row] = (await tx.execute<{ threshold: string; docs: string }>(sql`
    select coalesce((settings->>'line_item_doc_threshold_paise')::bigint, 0) as threshold,
           (select count(*) from attachments
             where entity_type = 'LINE_ITEM' and entity_id = ${lineItemId} and removed_at is null) as docs
    from fests where id = ${festId}
  `)) as unknown as { threshold: string; docs: string }[];

  const threshold = Number(row?.threshold ?? 0);
  if (threshold > 0 && plannedPaise >= threshold && Number(row.docs) === 0) {
    throw new ApiError("VALIDATION_ERROR",
      "This line item needs at least one supporting document (quotation or listing) before requests can attach to it",
      { line_item_doc_threshold_paise: threshold, planned_paise: plannedPaise });
  }
}

const MAX_RECEIPTS = 5; // PRD 7.2

async function bindReceipts(tx: Tx, actor: Actor, requestId: string, attachmentIds: string[]) {
  if (attachmentIds.length > MAX_RECEIPTS) {
    throw new ApiError("VALIDATION_ERROR", `At most ${MAX_RECEIPTS} receipts per request`);
  }
  for (const id of attachmentIds) {
    await bindAttachment(tx, actor, id, "REIMBURSEMENT", requestId, null);
  }
}

async function bindAttachment(
  tx: Tx, actor: Actor, attachmentId: string,
  entityType: "REIMBURSEMENT", entityId: string, purpose: "PAYMENT_PROOF" | null,
) {
  const updated = await tx.update(attachments)
    .set({ entityType, entityId, ...(purpose ? { purpose } : {}) })
    .where(and(
      eq(attachments.id, attachmentId),
      eq(attachments.festId, actor.festId),
      eq(attachments.uploadedBy, actor.id),
      isNull(attachments.entityId),
    ))
    .returning({ id: attachments.id });
  if (updated.length === 0) {
    throw new ApiError("VALIDATION_ERROR", `Attachment ${attachmentId} is not available to bind`);
  }
}

async function openHighFlags(tx: Tx, requestId: string) {
  return tx.select({ rule: flags.rule, explanation: flags.explanation }).from(flags)
    .where(and(
      eq(flags.entityType, "REIMBURSEMENT"), eq(flags.entityId, requestId),
      eq(flags.status, "OPEN"), eq(flags.severity, "HIGH"),
    ));
}

/** 20.1 — a detail GET returns the record plus everything the screen needs. */
export async function getReimbursementDetail(actor: Actor, id: string) {
  const row = await load(db as unknown as Tx, actor, id);
  const [receipts, openFlags, thread, timeline, submitter] = await Promise.all([
    db.select().from(attachments).where(and(
      eq(attachments.entityType, "REIMBURSEMENT"), eq(attachments.entityId, id), isNull(attachments.removedAt),
    )),
    db.select().from(flags).where(and(eq(flags.entityType, "REIMBURSEMENT"), eq(flags.entityId, id))),
    db.select({
      id: comments.id, body: comments.body, createdAt: comments.createdAt,
      editedAt: comments.editedAt, author: users.name,
    }).from(comments).innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.entityType, "REIMBURSEMENT"), eq(comments.entityId, id)))
      .orderBy(comments.createdAt),
    db.select({
      action: auditEvents.action, reason: auditEvents.reason, createdAt: auditEvents.createdAt,
      before: auditEvents.before, after: auditEvents.after, actor: users.name,
    }).from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(and(eq(auditEvents.entityType, "REIMBURSEMENT"), eq(auditEvents.entityId, id)))
      .orderBy(desc(auditEvents.createdAt)),
    db.select({ name: users.name, role: users.role }).from(users).where(eq(users.id, row.submitterId)).limit(1),
  ]);

  return {
    ...row,
    submitter: submitter[0],
    waiting_on: waitingOn(row.status, submitter[0].role),
    attachments: receipts, flags: openFlags, comments: thread, timeline,
  };
}
