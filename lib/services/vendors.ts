/**
 * Vendors and vendor payment requests (PRD 7.3, 20.7).
 *
 * The money model: on APPROVE the *entire* approved value moves to Committed; each
 * payment against a milestone — in full or in part — moves that amount from
 * Committed to Spent; reducing the balance at release returns the difference to
 * Available. All of that falls out of the views in
 * 19.4 — nothing here writes a derived number.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  attachments, auditEvents, comments, flags, lineItems, users,
  vendorMilestones, vendorPayments, vendorRequests, vendors,
} from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, can, maskAccountNumber, satisfiesActorConstraints, type Actor } from "@/lib/authz";
import { nextHumanId } from "@/lib/human-id";
import { formatPaise } from "@/lib/money";
import {
  assertVendorTransition, landingStateAfterPayment, type VendorAction, type VendorState,
} from "@/lib/state-machines/vendor";
import { evaluateVendorFlags } from "@/lib/flags";
import { recordAudit, snapshot } from "./audit";
import {
  notifyHighFlags, notifyMoneyTransition, VENDOR_RULES, type Party,
} from "./notify-routing";

const PAYMENT_ACTIONS: readonly VendorAction[] = ["RECORD_ADVANCE", "RECORD_BALANCE", "RECORD_REMAINING"];

/**
 * What is still owed on a milestone. Settled (`paid_at` set) means nothing; otherwise
 * whatever of the plan has not been paid yet, which for a part-paid milestone is the
 * remainder.
 */
export const owedOn = (m: { plannedPaise: number; paidPaise: number | null; paidAt: Date | null }) =>
  m.paidAt ? 0 : Math.max(0, m.plannedPaise - (m.paidPaise ?? 0));

const AUDITED = [
  "status", "totalValuePaise", "approvedValuePaise", "lineItemId", "vendorId",
  "description", "expectedDeliveryOn", "deliveredAt", "refundReceivedPaise",
] as const;

/* ------------------------------------------------------------------- vendors */

export interface VendorInput {
  name: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  upiId?: string | null;
  gstin?: string | null;
  notes?: string | null;
}

export async function createVendor(actor: Actor, input: VendorInput) {
  assertCan(actor, "vendor.manage", { festId: actor.festId, departmentId: actor.departmentId });
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(vendors).values({ festId: actor.festId, ...input, createdBy: actor.id }).returning();
    await recordAudit(tx, {
      festId: actor.festId, entityType: "VENDOR", entityId: row.id, actorId: actor.id,
      action: "vendor.create", after: { name: row.name, contact_name: row.contactName },
    });
    return row;
  });
}

export async function updateVendor(actor: Actor, id: string, input: Partial<VendorInput>) {
  assertCan(actor, "vendor.manage", { festId: actor.festId, departmentId: actor.departmentId });
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(vendors)
      .where(and(eq(vendors.id, id), eq(vendors.festId, actor.festId), isNull(vendors.deletedAt))).limit(1);
    if (!before) throw notFound("Vendor");

    const [after] = await tx.update(vendors).set({ ...input, updatedAt: new Date() })
      .where(eq(vendors.id, id)).returning();

    // Bank details are logged with before/after masked — the log must not become a leak.
    await recordAudit(tx, {
      festId: actor.festId, entityType: "VENDOR", entityId: id, actorId: actor.id,
      action: "vendor.update",
      before: { name: before.name, bank_account_number: maskAccountNumber(before.bankAccountNumber), upi_id: before.upiId },
      after: { name: after.name, bank_account_number: maskAccountNumber(after.bankAccountNumber), upi_id: after.upiId },
    });
    return after;
  });
}

/**
 * Retiring a vendor (soft, per 18.2 rule 7).
 *
 * A vendor is the payee on every request raised against it, so deleting one is not
 * a tidying-up action — it is removing the counterparty from a payment trail. The
 * row is therefore only ever marked deleted, never removed, and the attempt is
 * refused outright while any obligation is still live: an approved request with an
 * unpaid balance has to be settled or cancelled first, by the people whose job that
 * is. History (closed, declined, cancelled) is no obstacle — that is what soft
 * delete is for.
 */
export async function deleteVendor(actor: Actor, id: string, reason?: string) {
  assertCan(actor, "vendor.delete", { festId: actor.festId });

  return db.transaction(async (tx) => {
    const [vendor] = await tx.select().from(vendors)
      .where(and(eq(vendors.id, id), eq(vendors.festId, actor.festId), isNull(vendors.deletedAt)))
      .for("update");
    if (!vendor) throw notFound("Vendor");

    const live = (await tx.select({
      id: vendorRequests.id, humanId: vendorRequests.humanId, status: vendorRequests.status,
    }).from(vendorRequests)
      .where(and(
        eq(vendorRequests.vendorId, id),
        isNull(vendorRequests.deletedAt),
        sql`${vendorRequests.status} not in ('DRAFT','DECLINED','CANCELLED','CLOSED')`,
      ))
      .limit(5));

    if (live.length > 0) {
      throw conflict(
        `${vendor.name} still has ${live.length === 1 ? "a request" : "requests"} in flight`,
        { requests: live.map((r) => ({ human_id: r.humanId, status: r.status })) },
      );
    }

    const [after] = await tx.update(vendors)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(vendors.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "VENDOR", entityId: id, actorId: actor.id,
      action: "vendor.delete",
      before: { name: vendor.name, deleted_at: null },
      after: { name: after.name, deleted_at: after.deletedAt },
      reason: reason?.trim() || null,
    });
    return { ok: true, id };
  });
}

/** 20.7 — bank fields are masked for anyone who may not see them in full. */
export function redactVendor<T extends { bankAccountNumber: string | null }>(actor: Actor, vendor: T): T {
  if (can(actor, "vendor.bankDetails.view", { festId: actor.festId })) return vendor;
  return { ...vendor, bankAccountNumber: maskAccountNumber(vendor.bankAccountNumber) };
}

/** Total contracted, paid and outstanding across every department (7.3). */
export async function vendorExposure(festId: string, vendorId?: string) {
  const rows = (await db.execute(sql`
    select v.id as vendor_id, v.name,
           coalesce(sum(coalesce(vr.approved_value_paise, vr.total_value_paise))
             filter (where vr.status not in ('DRAFT','SUBMITTED','SENT_BACK','DECLINED')), 0) as contracted,
           coalesce(sum(m.paid), 0)                                as paid,
           coalesce(sum(vr.refund_received_paise), 0)              as refunded,
           count(vr.id) filter (where vr.deleted_at is null)       as request_count
      from vendors v
      left join vendor_requests vr on vr.vendor_id = v.id and vr.deleted_at is null
      left join lateral (
        select coalesce(sum(paid_paise), 0) as paid from vendor_milestones where vendor_request_id = vr.id
      ) m on true
     where v.fest_id = ${festId} and v.deleted_at is null
       ${vendorId ? sql`and v.id = ${vendorId}` : sql``}
     group by v.id, v.name
     order by contracted desc
  `)) as unknown as Record<string, string>[];

  return rows.map((r) => {
    const contracted = Number(r.contracted);
    const paid = Number(r.paid);
    const refunded = Number(r.refunded);
    return {
      vendorId: String(r.vendor_id),
      name: String(r.name),
      contractedPaise: contracted,
      paidPaise: paid,
      refundedPaise: refunded,
      outstandingPaise: contracted - paid,
      requestCount: Number(r.request_count),
    };
  });
}

/* ----------------------------------------------------------- vendor requests */

export interface CreateVendorRequestInput {
  vendorId: string;
  lineItemId: string;
  description: string;
  totalValuePaise: number;
  /** MVP sends exactly ADVANCE + BALANCE; the model allows more (7.3). */
  milestones: { kind: "ADVANCE" | "BALANCE" | "OTHER"; plannedPaise: number }[];
  expectedDeliveryOn?: string | null;
  attachmentIds?: string[];
  submit?: boolean;
}

export async function createVendorRequest(actor: Actor, input: CreateVendorRequestInput) {
  return db.transaction(async (tx) => {
    const item = await loadOpenLineItem(tx, actor, input.lineItemId);
    assertCan(actor, "vendorRequest.create", { festId: actor.festId, departmentId: item.departmentId });

    assertMilestonesSum(input.milestones, input.totalValuePaise);

    const [vendor] = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors)
      .where(and(eq(vendors.id, input.vendorId), eq(vendors.festId, actor.festId), isNull(vendors.deletedAt))).limit(1);
    if (!vendor) throw notFound("Vendor");

    const humanId = await nextHumanId(tx, actor.festId, "VP");
    const [row] = await tx.insert(vendorRequests).values({
      festId: actor.festId,
      humanId,
      departmentId: item.departmentId,
      lineItemId: item.id,
      vendorId: input.vendorId,
      description: input.description,
      totalValuePaise: input.totalValuePaise,
      expectedDeliveryOn: input.expectedDeliveryOn ?? null,
      status: input.submit ? "SUBMITTED" : "DRAFT",
      requestedBy: actor.id,
    }).returning();

    await tx.insert(vendorMilestones).values(
      input.milestones.map((m, i) => ({
        vendorRequestId: row.id, kind: m.kind, sortOrder: i, plannedPaise: m.plannedPaise,
      })),
    );

    for (const id of input.attachmentIds ?? []) {
      await bindAttachment(tx, actor, id, row.id, "QUOTE");
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "VENDOR_REQUEST", entityId: row.id, actorId: actor.id,
      action: input.submit ? "vendor_request.submit" : "vendor_request.create",
      after: snapshot(row, AUDITED),
    });
    const raised = await evaluateVendorFlags(tx, row.id);

    if (input.submit) {
      const party = partyOf(row, actor.id);
      await notifyMoneyTransition(tx, VENDOR_RULES, "SUBMIT", party, {
        humanId: row.humanId, description: row.description,
        amountPaise: row.totalValuePaise,
        actorName: await actorNameOf(tx, actor.id),
        vendorName: vendor.name,
      });
      await notifyHighFlags(tx, party, row.humanId, raised);
    }
    return row;
  });
}

/** The parties PRD 10 routes a vendor notification to. */
function partyOf(
  row: { festId: string; id: string; requestedBy: string; departmentId: string }, actorId: string,
): Party {
  return {
    festId: row.festId, entityType: "VENDOR_REQUEST", entityId: row.id,
    submitterId: row.requestedBy, departmentId: row.departmentId, actorId,
  };
}

async function actorNameOf(tx: Tx, actorId: string): Promise<string> {
  const [row] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actorId)).limit(1);
  return row?.name ?? "Someone";
}

export interface VendorTransitionBody {
  reason?: string;
  approved_value_paise?: number;
  milestone_id?: string;
  paid_paise?: number;
  paid_at?: string;
  payment_reference?: string;
  proof_attachment_id?: string;
  delivered_at?: string;
  note?: string;
  invoice_attachment_id?: string;
  invoice_total_paise?: number;
  refund_expected_paise?: number;
  amount_paise?: number;
  received_at?: string;
  reference?: string;
}

export async function transitionVendorRequest(
  actor: Actor, id: string, action: VendorAction, body: VendorTransitionBody = {},
) {
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);
    const milestones = await loadMilestones(tx, id);

    const resource = {
      festId: actor.festId,
      departmentId: before.departmentId,
      targetDepartmentId: before.departmentId,
      submitterId: before.requestedBy,
      status: before.status,
    };

    const transition = assertVendorTransition(before.status, action, actor.role, body as Record<string, unknown>);
    if (!satisfiesActorConstraints(transition.actor, actor, resource)) {
      throw new ApiError("FORBIDDEN", `You may not ${action} this vendor request`);
    }
    assertActionPermission(actor, action, resource);

    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };
    let to: VendorState = before.status;
    /** Set by a payment: what it did, for the audit line and who is told. */
    let payment: { settled: boolean; kind: string; summary: string } | null = null;

    switch (action) {
      case "SUBMIT":
      case "RESUBMIT":
        to = "SUBMITTED";
        break;

      case "APPROVE": {
        /*
         * 5.2's exception for vendor payments: the Finance HOD may approve a request
         * they raised — so Finance can raise one for any department without a second
         * Finance HOD — but only by saying why. The note is the compensating
         * control: it is on the record, and Management is told of the approval.
         */
        if (before.requestedBy === actor.id && !(body.note ?? body.reason)?.trim()) {
          throw new ApiError(
            "VALIDATION_ERROR",
            "You raised this request, so approving it yourself needs a note saying why (5.2).",
          );
        }
        const approved = body.approved_value_paise ?? before.totalValuePaise;
        if (approved <= 0 || approved > before.totalValuePaise) {
          throw new ApiError("VALIDATION_ERROR", "Approved value must be positive and at most the requested total");
        }
        await rescaleMilestones(tx, milestones, approved);
        to = "APPROVED";
        Object.assign(patch, { approvedValuePaise: approved, approvedBy: actor.id, approvedAt: now });
        break;
      }

      case "SEND_BACK": to = "SENT_BACK"; break;
      case "DECLINE": to = "DECLINED"; break;

      case "RECORD_ADVANCE":
      case "RECORD_BALANCE":
      case "RECORD_REMAINING": {
        const milestone = milestones.find((m) => m.id === body.milestone_id);
        if (!milestone) throw notFound("Milestone");
        if (milestone.paidAt !== null) throw conflict("That milestone is already paid in full");
        const amount = body.paid_paise!;
        if (amount <= 0) throw new ApiError("VALIDATION_ERROR", "Paid amount must be positive");

        const alreadyPaid = milestone.paidPaise ?? 0;
        const remaining = owedOn(milestone);

        /*
         * The first payment on a milestone names it: the advance or the balance. Once
         * part of it is paid, what is left is the remaining payment, whichever stage
         * the request has reached — an advance half-paid before delivery is still
         * owed after it.
         */
        if (action === "RECORD_REMAINING") {
          if (alreadyPaid === 0) {
            throw new ApiError("VALIDATION_ERROR",
              "Nothing has been paid on that milestone yet; record the advance or the balance instead");
          }
        } else {
          if (alreadyPaid > 0) {
            throw new ApiError("VALIDATION_ERROR",
              "Part of that milestone is already paid; record the remaining payment instead");
          }
          /*
           * The action names which milestone it is for, so it has to be that kind of
           * milestone. Without this, `RECORD_ADVANCE` against the balance milestone
           * marks the balance paid and leaves the request in ADVANCE_PAID — a request
           * that reads as half-settled with nothing left to pay.
           */
          const wantsAdvance = action === "RECORD_ADVANCE";
          if (wantsAdvance !== (milestone.kind === "ADVANCE")) {
            throw new ApiError(
              "VALIDATION_ERROR",
              wantsAdvance
                ? "That is not the advance milestone; record the balance instead"
                : "That is the advance milestone; record the advance instead",
            );
          }
        }

        /*
         * Paid in full, or paid in part — never more than is owed.
         *
         * A part payment is exactly that: the milestone stays unsettled, and what is
         * left of it stays Committed and owed until the remaining payment is
         * recorded. That is what keeps a ₹1 transfer against a ₹24,000 balance from
         * closing the request and quietly dropping ₹23,999.99 out of Committed.
         * Settling for *less* than was agreed is still the release's job (7.3): it
         * needs a reason, and the difference visibly goes back to the department.
         */
        if (amount > remaining) {
          throw new ApiError(
            "VALIDATION_ERROR",
            `A payment cannot be more than is owed on the milestone (${formatPaise(remaining)}). `
              + "Raise the approved value before paying more.",
            { owed_paise: remaining, offered_paise: amount },
          );
        }
        const settled = amount === remaining;
        const paidAt = new Date(body.paid_at!);

        await tx.update(vendorMilestones).set({
          paidPaise: alreadyPaid + amount,
          updatedAt: now,
          // `paid_at` means settled; a part payment leaves it empty (0016).
          ...(settled ? { paidAt, paidBy: actor.id, paymentReference: body.payment_reference! } : {}),
        }).where(eq(vendorMilestones.id, milestone.id));

        await tx.insert(vendorPayments).values({
          festId: actor.festId, vendorRequestId: id, milestoneId: milestone.id,
          amountPaise: amount, paidAt, paidBy: actor.id,
          paymentReference: body.payment_reference!,
          proofAttachmentId: body.proof_attachment_id ?? null,
        });

        /*
         * Closing is "nothing is owed", not "the balance action was used". The MVP
         * makes two milestones, but the model allows more (19.x), and a request with
         * a third still unpaid — or an advance still part-paid — must not close:
         * CLOSED leaves Committed entirely (0001_views.sql), so whatever is still
         * owed would simply vanish.
         */
        const stillOwed = milestones.reduce(
          (sum, m) => sum + (m.id === milestone.id ? remaining - amount : owedOn(m)), 0,
        );
        to = landingStateAfterPayment(before.status, { kind: milestone.kind, settled }, stillOwed);
        if (to === "CLOSED") patch.closedAt = now;

        payment = {
          settled, kind: milestone.kind,
          summary: settled
            ? `${formatPaise(amount)} paid; the ${milestone.kind.toLowerCase()} is paid in full`
            : `${formatPaise(amount)} paid in part; ${formatPaise(remaining - amount)} of the `
              + `${milestone.kind.toLowerCase()} still owed`,
        };
        break;
      }

      case "CONFIRM_DELIVERY":
        to = "DELIVERED";
        Object.assign(patch, {
          deliveredAt: new Date(body.delivered_at!),
          deliveryNote: body.note ?? null,
          deliveryConfirmedBy: actor.id,
        });
        await bindAttachment(tx, actor, body.invoice_attachment_id!, id, "INVOICE", body.invoice_total_paise);
        break;

      case "RELEASE_BALANCE": {
        const current = before.approvedValuePaise ?? before.totalValuePaise;
        const released = body.approved_value_paise ?? current;
        if (released > current) {
          throw new ApiError("VALIDATION_ERROR", "The balance can be reduced at release, never increased");
        }
        if (released !== current && !body.reason) {
          throw new ApiError("VALIDATION_ERROR", "Changing the approved value needs a reason");
        }
        if (released !== current) {
          const paid = milestones.reduce((sum, m) => sum + (m.paidPaise ?? 0), 0);
          if (released < paid) {
            throw new ApiError("VALIDATION_ERROR", "The approved value cannot drop below what is already paid");
          }
          await rescaleUnpaidMilestones(tx, milestones, released - paid);
        }
        to = "BALANCE_APPROVED";
        Object.assign(patch, {
          approvedValuePaise: released, balanceApprovedBy: actor.id,
          balanceApprovedAt: now, balanceAdjustReason: released !== current ? body.reason : null,
        });
        break;
      }

      case "CLOSE": {
        const unpaid = milestones.reduce((s, m) => s + owedOn(m), 0);
        if (unpaid !== 0) {
          throw new ApiError("VALIDATION_ERROR", "Close is only for a zero balance; release the balance instead");
        }
        to = "CLOSED";
        patch.closedAt = now;
        break;
      }

      case "CANCEL": {
        const paid = milestones.reduce((sum, m) => sum + (m.paidPaise ?? 0), 0);
        to = "CANCELLED";
        Object.assign(patch, {
          // Whatever was already paid is expected back unless Finance says otherwise (7.3).
          refundExpectedPaise: body.refund_expected_paise ?? paid,
        });
        break;
      }

      case "RECORD_REFUND": {
        const received = before.refundReceivedPaise + body.amount_paise!;
        if (received > before.refundExpectedPaise) {
          throw new ApiError("VALIDATION_ERROR", "Refund received cannot exceed the refund expected");
        }
        to = "CANCELLED";
        Object.assign(patch, { refundReceivedPaise: received, refundReceivedAt: new Date(body.received_at!) });
        break;
      }
    }

    if (body.reason) patch.lastReason = body.reason;

    const [after] = await tx.update(vendorRequests).set({ ...patch, status: to })
      .where(and(eq(vendorRequests.id, id), eq(vendorRequests.status, before.status)))
      .returning();
    if (!after) throw conflict("This request changed while you were looking at it");

    if (PAYMENT_ACTIONS.includes(action) && body.proof_attachment_id) {
      await bindAttachment(tx, actor, body.proof_attachment_id, id, "PAYMENT_PROOF");
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "VENDOR_REQUEST", entityId: id, actorId: actor.id,
      action: `vendor_request.transition.${action}`,
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
      // A payment's line on the timeline says whether it settled anything.
      reason: body.reason ?? body.note ?? payment?.summary ?? null,
    });
    const raised = await evaluateVendorFlags(tx, id);

    // PRD 10 — the recipient table lives in notify-routing, not in branches here.
    const party = partyOf(after, actor.id);
    const [meta] = (await tx.execute(sql`
      select v.name as vendor_name, d.name as department_name
        from vendor_requests vr
        join vendors v on v.id = vr.vendor_id
        join departments d on d.id = vr.department_id
       where vr.id = ${id}
    `)) as unknown as { vendor_name: string; department_name: string }[];

    /*
     * Who hears about a payment depends on what it did, not which button recorded
     * it: a part payment is not "advance paid", and a balance that leaves something
     * else owed is not "closed and fully paid".
     */
    const rule = !payment ? action
      : !payment.settled ? "PARTIAL_PAYMENT"
      : to === "CLOSED" ? "RECORD_BALANCE"
      : payment.kind === "ADVANCE" ? "RECORD_ADVANCE"
      : "MILESTONE_PAID";

    await notifyMoneyTransition(tx, VENDOR_RULES, rule, party, {
      humanId: after.humanId,
      description: after.description,
      amountPaise: payment ? (body.paid_paise ?? 0) : (after.approvedValuePaise ?? after.totalValuePaise),
      actorName: await actorNameOf(tx, actor.id),
      reason: body.reason ?? body.note ?? payment?.summary ?? null,
      departmentName: meta?.department_name,
      vendorName: meta?.vendor_name,
    });
    await notifyHighFlags(tx, party, after.humanId, raised);

    return after;
  });
}

function assertActionPermission(
  actor: Actor, action: VendorAction,
  resource: { festId: string; departmentId: string; submitterId: string; status: string },
) {
  if (action === "APPROVE" || action === "RELEASE_BALANCE" || action === "CLOSE" || action === "CANCEL") {
    assertCan(actor, "vendorRequest.approve", resource);
  }
  if (action === "CONFIRM_DELIVERY") assertCan(actor, "vendorRequest.confirmDelivery", resource);
  if (PAYMENT_ACTIONS.includes(action) || action === "RECORD_REFUND") {
    assertCan(actor, "vendorRequest.recordPayment", resource);
  }
}

function assertMilestonesSum(
  milestones: { plannedPaise: number }[], total: number,
) {
  if (milestones.length === 0) throw new ApiError("VALIDATION_ERROR", "A vendor request needs at least one milestone");
  const sum = milestones.reduce((s, m) => s + m.plannedPaise, 0);
  if (sum !== total) {
    throw new ApiError("VALIDATION_ERROR", "Milestones must add up to the total value", {
      milestones_paise: sum, total_value_paise: total,
    });
  }
}

/** Approving below the requested total shrinks the unpaid milestones proportionally. */
async function rescaleMilestones(
  tx: Tx,
  milestones: { id: string; plannedPaise: number; paidPaise: number | null }[],
  approved: number,
) {
  const planned = milestones.reduce((s, m) => s + m.plannedPaise, 0);
  if (planned === approved) return;
  let allocated = 0;
  for (const [i, m] of milestones.entries()) {
    const share = i === milestones.length - 1
      ? approved - allocated                                    // last one absorbs the rounding
      : Math.round((m.plannedPaise / planned) * approved);
    allocated += share;
    await tx.update(vendorMilestones).set({ plannedPaise: share }).where(eq(vendorMilestones.id, m.id));
  }
}

/**
 * Reducing the balance at release only touches what is still owed. A settled
 * milestone keeps its plan; one paid in part keeps what was paid on it, and only its
 * remainder is shared out of `remaining`.
 */
async function rescaleUnpaidMilestones(
  tx: Tx,
  milestones: { id: string; plannedPaise: number; paidPaise: number | null; paidAt: Date | null }[],
  remaining: number,
) {
  const open = milestones.filter((m) => m.paidAt === null);
  const owed = open.reduce((s, m) => s + owedOn(m), 0);
  let allocated = 0;
  for (const [i, m] of open.entries()) {
    const share = i === open.length - 1
      ? remaining - allocated
      : owed === 0 ? 0 : Math.round((owedOn(m) / owed) * remaining);
    allocated += share;
    await tx.update(vendorMilestones)
      .set({ plannedPaise: (m.paidPaise ?? 0) + share })
      .where(eq(vendorMilestones.id, m.id));
  }
}

async function load(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(vendorRequests)
    .where(and(eq(vendorRequests.id, id), eq(vendorRequests.festId, actor.festId), isNull(vendorRequests.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Vendor request");
  assertCan(actor, "vendorRequest.view", { festId: actor.festId, departmentId: row.departmentId });
  return row;
}

async function loadMilestones(tx: Tx, requestId: string) {
  return tx.select().from(vendorMilestones)
    .where(eq(vendorMilestones.vendorRequestId, requestId))
    .orderBy(vendorMilestones.sortOrder);
}

async function loadOpenLineItem(tx: Tx, actor: Actor, lineItemId: string) {
  const [item] = await tx.select().from(lineItems)
    .where(and(eq(lineItems.id, lineItemId), eq(lineItems.festId, actor.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!item) throw notFound("Line item");
  if (item.status === "CLOSED") {
    throw new ApiError("VALIDATION_ERROR", `${item.name} is closed; no new requests can attach to it`);
  }
  return item;
}

async function bindAttachment(
  tx: Tx, actor: Actor, attachmentId: string, requestId: string,
  purpose: "QUOTE" | "INVOICE" | "PAYMENT_PROOF", quotedAmountPaise?: number,
) {
  const updated = await tx.update(attachments)
    .set({
      entityType: "VENDOR_REQUEST", entityId: requestId, purpose,
      ...(quotedAmountPaise !== undefined ? { quotedAmountPaise } : {}),
    })
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

/** 20.1 — one call returns everything the detail screen needs. */
export async function getVendorRequestDetail(actor: Actor, id: string) {
  const row = await load(db as unknown as Tx, actor, id);
  const [milestones, payments, files, openFlags, thread, timeline, vendor, item, requester] = await Promise.all([
    db.select().from(vendorMilestones).where(eq(vendorMilestones.vendorRequestId, id)).orderBy(vendorMilestones.sortOrder),
    db.select({
      id: vendorPayments.id, milestoneId: vendorPayments.milestoneId, amountPaise: vendorPayments.amountPaise,
      paidAt: vendorPayments.paidAt, paymentReference: vendorPayments.paymentReference,
      proofAttachmentId: vendorPayments.proofAttachmentId, paidBy: users.name,
    }).from(vendorPayments).leftJoin(users, eq(users.id, vendorPayments.paidBy))
      .where(eq(vendorPayments.vendorRequestId, id))
      .orderBy(vendorPayments.paidAt, vendorPayments.createdAt),
    db.select().from(attachments).where(and(
      eq(attachments.entityType, "VENDOR_REQUEST"), eq(attachments.entityId, id), isNull(attachments.removedAt),
    )),
    db.select().from(flags).where(and(eq(flags.entityType, "VENDOR_REQUEST"), eq(flags.entityId, id))),
    db.select({ id: comments.id, body: comments.body, createdAt: comments.createdAt, editedAt: comments.editedAt, author: users.name })
      .from(comments).innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.entityType, "VENDOR_REQUEST"), eq(comments.entityId, id)))
      .orderBy(comments.createdAt),
    db.select({ action: auditEvents.action, reason: auditEvents.reason, createdAt: auditEvents.createdAt, actor: users.name })
      .from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(and(eq(auditEvents.entityType, "VENDOR_REQUEST"), eq(auditEvents.entityId, id)))
      .orderBy(auditEvents.createdAt),
    db.select().from(vendors).where(eq(vendors.id, row.vendorId)).limit(1),
    db.select({ id: lineItems.id, name: lineItems.name }).from(lineItems).where(eq(lineItems.id, row.lineItemId)).limit(1),
    db.select({ name: users.name }).from(users).where(eq(users.id, row.requestedBy)).limit(1),
  ]);

  return {
    ...row,
    vendor: redactVendor(actor, vendor[0]),
    lineItem: item[0],
    requester: requester[0],
    milestones,
    payments,
    attachments: files,
    flags: openFlags,
    comments: thread,
    timeline,
  };
}

/**
 * PRD 20.7 — the requester correcting a vendor request before Finance sees it.
 *
 * Editing is confined to DRAFT and SENT_BACK by `can` (5.2 / 20.7): once Finance has
 * approved a value, changing it behind their back would make the approval a lie.
 * Milestones are replaced wholesale rather than patched, because they must always
 * sum to the total and a partial update cannot guarantee that.
 */
export interface UpdateVendorRequestInput {
  description?: string;
  totalValuePaise?: number;
  expectedDeliveryOn?: string | null;
  vendorId?: string;
  lineItemId?: string;
  milestones?: { kind: "ADVANCE" | "BALANCE" | "OTHER"; plannedPaise: number }[];
}

export async function updateVendorRequest(actor: Actor, id: string, input: UpdateVendorRequestInput) {
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);
    assertCan(actor, "vendorRequest.edit", {
      festId: actor.festId,
      departmentId: before.departmentId,
      submitterId: before.requestedBy,
      status: before.status,
    });

    let departmentId = before.departmentId;
    let lineItemId = before.lineItemId;
    if (input.lineItemId && input.lineItemId !== before.lineItemId) {
      const item = await loadOpenLineItem(tx, actor, input.lineItemId);
      assertCan(actor, "vendorRequest.create", { festId: actor.festId, departmentId: item.departmentId });
      departmentId = item.departmentId;
      lineItemId = item.id;
    }

    if (input.vendorId && input.vendorId !== before.vendorId) {
      const [vendor] = await tx.select({ id: vendors.id }).from(vendors)
        .where(and(eq(vendors.id, input.vendorId), eq(vendors.festId, actor.festId), isNull(vendors.deletedAt)))
        .limit(1);
      if (!vendor) throw notFound("Vendor");
    }

    const total = input.totalValuePaise ?? before.totalValuePaise;
    if (input.milestones) assertMilestonesSum(input.milestones, total);
    else if (input.totalValuePaise !== undefined) {
      // Changing the total without restating the milestones would leave them
      // summing to the old figure, which the state machine relies on.
      const existing = await loadMilestones(tx, id);
      assertMilestonesSum(
        existing.map((m) => ({ kind: m.kind, plannedPaise: m.plannedPaise })),
        total,
      );
    }

    const [after] = await tx.update(vendorRequests).set({
      description: input.description ?? before.description,
      totalValuePaise: total,
      expectedDeliveryOn: input.expectedDeliveryOn === undefined
        ? before.expectedDeliveryOn : input.expectedDeliveryOn,
      vendorId: input.vendorId ?? before.vendorId,
      lineItemId,
      departmentId,
      updatedAt: new Date(),
    }).where(and(
      eq(vendorRequests.id, id),
      eq(vendorRequests.status, before.status),
    )).returning();
    if (!after) throw conflict("This request changed while you were looking at it");

    if (input.milestones) {
      await tx.delete(vendorMilestones).where(and(
        eq(vendorMilestones.vendorRequestId, id),
        isNull(vendorMilestones.paidAt),
      ));
      await tx.insert(vendorMilestones).values(
        input.milestones.map((m, i) => ({
          vendorRequestId: id, kind: m.kind, sortOrder: i, plannedPaise: m.plannedPaise,
        })),
      );
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "VENDOR_REQUEST", entityId: id, actorId: actor.id,
      action: "vendor_request.update",
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
    });
    await evaluateVendorFlags(tx, id);
    return after;
  });
}
