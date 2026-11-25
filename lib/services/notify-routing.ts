/**
 * The PRD 10 recipient table, as data.
 *
 * The table in section 10 is a list of "when X happens, tell Y". Written inline in
 * each service it becomes a scatter of conditionals that nobody can check against
 * the spec; written here it can be read next to the PRD line by line, and the
 * services just say what happened.
 *
 * Two rules hold across every entry:
 *   - Nobody is told about their own action. The person who clicked approve does
 *     not need an email saying it was approved.
 *   - Every message names the money, the record, and who owns the next move.
 */
import type { Tx } from "@/db";
import { formatPaise } from "@/lib/money";
import { notify, type NotifyInput } from "./notifications";

type Audience =
  | "SUBMITTER" | "DEPT_HOD" | "FINANCE" | "MANAGEMENT" | "REQUESTER" | "ALL_THREE";

interface Rule {
  /** Who hears about it (PRD 10). */
  to: Audience[];
  /** What the subject line says. `{id}` is the human ID. */
  title: (ctx: Ctx) => string;
  /** Whose move it is next — the sentence that stops a request stalling. */
  waitingOn?: string;
}

export interface Ctx {
  humanId: string;
  description: string;
  amountPaise: number;
  actorName: string;
  reason?: string | null;
  departmentName?: string;
  vendorName?: string;
}

/* --------------------------------------------------------- reimbursements */

export const REIMBURSEMENT_RULES: Record<string, Rule> = {
  SUBMIT: {
    to: ["DEPT_HOD"],
    title: (c) => `${c.humanId} needs your endorsement`,
    waitingOn: "Waiting on: the department HOD",
  },
  RESUBMIT: {
    to: ["DEPT_HOD"],
    title: (c) => `${c.humanId} has been resubmitted`,
    waitingOn: "Waiting on: the department HOD",
  },
  ENDORSE: {
    to: ["FINANCE", "SUBMITTER"],
    title: (c) => `${c.humanId} is endorsed and with Finance`,
    waitingOn: "Waiting on: Finance HOD to approve",
  },
  SEND_BACK: {
    to: ["SUBMITTER", "DEPT_HOD"],
    title: (c) => `${c.humanId} was sent back for changes`,
    waitingOn: "Waiting on: you, to correct and resubmit",
  },
  DECLINE: {
    to: ["SUBMITTER", "DEPT_HOD"],
    title: (c) => `${c.humanId} was declined`,
  },
  APPROVE: {
    to: ["SUBMITTER", "DEPT_HOD", "MANAGEMENT"],
    title: (c) => `${c.humanId} is approved for payment`,
    waitingOn: "Waiting on: Management to make the transfer",
  },
  HOLD: {
    to: ["FINANCE", "SUBMITTER"],
    title: (c) => `${c.humanId} has been put on hold`,
    waitingOn: "Waiting on: Finance HOD to resolve the hold",
  },
  RESOLVE_HOLD: {
    to: ["MANAGEMENT", "SUBMITTER"],
    title: (c) => `${c.humanId} is off hold and payable again`,
    waitingOn: "Waiting on: Management to make the transfer",
  },
  RECORD_PAYMENT: {
    to: ["SUBMITTER", "DEPT_HOD"],
    title: (c) => `${c.humanId} has been paid`,
  },
  WITHDRAW: {
    to: ["DEPT_HOD"],
    title: (c) => `${c.humanId} was withdrawn by ${c.actorName}`,
  },
};

/* ------------------------------------------------------- vendor requests */

export const VENDOR_RULES: Record<string, Rule> = {
  SUBMIT: {
    to: ["FINANCE"],
    title: (c) => `${c.humanId} needs Finance approval`,
    waitingOn: "Waiting on: Finance HOD to approve",
  },
  RESUBMIT: {
    to: ["FINANCE"],
    title: (c) => `${c.humanId} has been resubmitted`,
    waitingOn: "Waiting on: Finance HOD to approve",
  },
  APPROVE: {
    to: ["REQUESTER", "MANAGEMENT"],
    title: (c) => `${c.humanId} is approved`,
    waitingOn: "Waiting on: the advance payment",
  },
  SEND_BACK: {
    to: ["REQUESTER"],
    title: (c) => `${c.humanId} was sent back for changes`,
    waitingOn: "Waiting on: you, to correct and resubmit",
  },
  DECLINE: {
    to: ["REQUESTER"],
    title: (c) => `${c.humanId} was declined`,
  },
  // Management and the Finance HOD both record vendor payments (5.2), so each
  // hears about the other's.
  RECORD_ADVANCE: {
    to: ["REQUESTER", "FINANCE", "MANAGEMENT"],
    title: (c) => `Advance paid on ${c.humanId}`,
    waitingOn: "Waiting on: delivery, then the balance",
  },
  PARTIAL_PAYMENT: {
    to: ["REQUESTER", "FINANCE", "MANAGEMENT"],
    title: (c) => `Part payment recorded on ${c.humanId}`,
    waitingOn: "Waiting on: the remaining payment",
  },
  MILESTONE_PAID: {
    to: ["REQUESTER", "FINANCE", "MANAGEMENT"],
    title: (c) => `A payment on ${c.humanId} is settled`,
    waitingOn: "Waiting on: what is still owed on it",
  },
  CONFIRM_DELIVERY: {
    to: ["FINANCE"],
    title: (c) => `Delivery confirmed on ${c.humanId}`,
    waitingOn: "Waiting on: Finance HOD to release the balance",
  },
  RELEASE_BALANCE: {
    to: ["MANAGEMENT", "REQUESTER"],
    title: (c) => `Balance released on ${c.humanId}`,
    waitingOn: "Waiting on: Management to pay the balance",
  },
  RECORD_BALANCE: {
    to: ["REQUESTER", "DEPT_HOD", "FINANCE", "MANAGEMENT"],
    title: (c) => `${c.humanId} is closed and fully paid`,
  },
  CLOSE: {
    to: ["REQUESTER", "FINANCE"],
    title: (c) => `${c.humanId} is closed`,
  },
  CANCEL: {
    to: ["REQUESTER", "MANAGEMENT", "FINANCE"],
    title: (c) => `${c.humanId} was cancelled`,
    waitingOn: "Waiting on: a refund, if one is due",
  },
  RECORD_REFUND: {
    to: ["REQUESTER", "FINANCE"],
    title: (c) => `Refund received on ${c.humanId}`,
  },
};

export interface Party {
  festId: string;
  entityType: NotifyInput["entityType"];
  entityId: string;
  /** The person who raised it. */
  submitterId: string;
  /** The department whose HOD hears about it. */
  departmentId: string;
  actorId: string;
}

/** Turns one rule plus the parties into a `notify` call. */
export async function notifyMoneyTransition(
  tx: Tx, rules: Record<string, Rule>, action: string, party: Party, ctx: Ctx,
): Promise<void> {
  const rule = rules[action];
  if (!rule) return;

  const audiences = new Set(rule.to);
  const toUsers: string[] = [];
  const toRoles: ("FINANCE_HOD" | "MANAGEMENT")[] = [];
  const toDepartmentHods: string[] = [];

  if (audiences.has("SUBMITTER") || audiences.has("REQUESTER")) toUsers.push(party.submitterId);
  if (audiences.has("DEPT_HOD")) toDepartmentHods.push(party.departmentId);
  if (audiences.has("FINANCE")) toRoles.push("FINANCE_HOD");
  if (audiences.has("MANAGEMENT")) toRoles.push("MANAGEMENT");

  const blocks = [
    { label: "Amount", value: formatPaise(ctx.amountPaise) },
    ...(ctx.departmentName ? [{ label: "Department", value: ctx.departmentName }] : []),
    ...(ctx.vendorName ? [{ label: "Vendor", value: ctx.vendorName }] : []),
    ...(ctx.reason ? [{ label: "Reason", value: ctx.reason }] : []),
  ];

  await notify(tx, {
    festId: party.festId,
    type: `${String(party.entityType).toLowerCase()}.${action.toLowerCase()}`,
    entityType: party.entityType,
    entityId: party.entityId,
    title: rule.title(ctx),
    body: `${ctx.description} — ${ctx.actorName}`,
    blocks,
    footnote: rule.waitingOn,
    toUsers,
    toRoles,
    toDepartmentHods,
    exceptUserId: party.actorId,
  });
}

/** 8.3 — a High flag is the one thing Finance should hear about immediately. */
export async function notifyHighFlags(
  tx: Tx, party: Party, humanId: string, flags: { rule: string; severity: string; explanation: string }[],
): Promise<void> {
  const high = flags.filter((f) => f.severity === "HIGH");
  if (high.length === 0) return;

  await notify(tx, {
    festId: party.festId,
    type: "flag.high",
    entityType: party.entityType,
    entityId: party.entityId,
    title: `${humanId} raised ${high.length} high flag${high.length === 1 ? "" : "s"}`,
    body: high.map((f) => f.explanation).join(" "),
    blocks: high.map((f) => ({ label: f.rule, value: f.explanation })),
    footnote: "Waiting on: Finance HOD to acknowledge or dismiss",
    toRoles: ["FINANCE_HOD"],
    exceptUserId: party.actorId,
  });
}
