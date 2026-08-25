/**
 * The one authorization function (PRD 18.2 rule 1).
 * Every route handler calls `can` / `assertCan` before doing anything.
 * The UI may call `can` to hide controls, but hiding is never the enforcement.
 *
 * Sources: permissions matrix 5.1, segregation of duties 5.2, per-endpoint roles in 20.x.
 */
import type { ActorConstraint, Role } from "./state-machines/types";

export interface Actor {
  id: string;
  festId: string;
  role: Role;
  departmentId: string;
  /**
   * Platform administrator (see `users.is_super_admin`). Orthogonal to `role`:
   * it grants oversight — the audit log, the close-out pack, appointing other
   * administrators — and never the authority to move money. A super admin who is a
   * Member still cannot approve a reimbursement, because 5.2's segregation rules
   * turn on the role and nothing here touches them.
   */
  isSuperAdmin?: boolean;
}

/** Everything `can` may need to know about the thing being acted on. */
export interface Resource {
  festId?: string;
  /** The department that owns the resource (a request's dept, a line item's dept). */
  departmentId?: string;
  /** Work tickets have two departments. */
  targetDepartmentId?: string;
  requestingDepartmentId?: string;
  /** Whoever created it — the person who may never approve or pay it. */
  submitterId?: string;
  requesterId?: string;
  assigneeId?: string;
  status?: string;
  /** For reimbursement approval routing (5.2): the submitter's role. */
  submitterRole?: Role;
}

export type Action =
  // reads
  | "fest.view" | "fest.settings.view"
  | "department.view" | "department.budget.view"
  | "lineItem.view" | "budgetReview.view"
  | "reimbursement.view" | "vendor.view" | "vendorRequest.view"
  | "vendor.bankDetails.view"
  | "income.view" | "ticket.view" | "flag.view" | "audit.view" | "export.run"
  | "closeOut.view" | "superAdmin.manage" | "allocationRequest.view"
  // writes — budget
  | "fest.manage" | "department.manage" | "budget.transfer"
  | "allocationRequest.create" | "allocationRequest.decide"
  | "lineItem.create" | "lineItem.edit" | "lineItem.close" | "lineItem.markReviewed"
  | "lineItem.document.manage"
  // writes — money
  | "reimbursement.create" | "reimbursement.edit" | "reimbursement.endorse"
  | "reimbursement.approve" | "reimbursement.recordPayment" | "reimbursement.hold"
  | "vendor.manage" | "vendor.delete" | "vendorRequest.create" | "vendorRequest.edit"
  | "vendorRequest.approve" | "vendorRequest.confirmDelivery" | "vendorRequest.recordPayment"
  | "income.manage"
  // writes — everything else
  | "ticket.create" | "ticket.triage" | "ticket.work" | "ticket.close" | "ticket.plan"
  | "comment.create" | "flag.resolve" | "flag.raise" | "user.manage" | "expenseType.manage";

const isFinance = (a: Actor) => a.role === "FINANCE_HOD";
const isSuperAdmin = (a: Actor) => a.isSuperAdmin === true;
const isManagement = (a: Actor) => a.role === "MANAGEMENT";
const isHod = (a: Actor) => a.role === "DEPT_HOD";

/** Finance HOD sees every department; a Dept HOD and Member see only their own. */
function ownsDepartment(actor: Actor, r: Resource): boolean {
  return r.departmentId !== undefined && r.departmentId === actor.departmentId;
}

function sameFest(actor: Actor, r: Resource): boolean {
  return r.festId === undefined || r.festId === actor.festId;
}

/** A user is party to a ticket if either department is theirs, or they are assignee/requester. */
function partyToTicket(actor: Actor, r: Resource): boolean {
  return (
    r.targetDepartmentId === actor.departmentId ||
    r.requestingDepartmentId === actor.departmentId ||
    r.assigneeId === actor.id ||
    r.requesterId === actor.id
  );
}

export function can(actor: Actor, action: Action, resource: Resource = {}): boolean {
  // Fest scoping (18.2 rule 10) — no cross-fest access, ever.
  if (!sameFest(actor, resource)) return false;

  const finance = isFinance(actor);
  const management = isManagement(actor);
  const hod = isHod(actor);
  const superAdmin = isSuperAdmin(actor);
  const own = ownsDepartment(actor, resource);

  switch (action) {
    /* ---------------------------------------------------------------- reads */
    case "fest.view":
      return true;
    case "fest.settings.view":
      return finance;

    case "department.view":
    case "department.budget.view":
    case "lineItem.view":
      // An administrator reads every department's numbers, not just their own. That
      // is the point of the flag: oversight of the whole fest, whatever role they
      // happen to hold.
      return finance || management || superAdmin || own;

    case "budgetReview.view":
      return finance;

    case "allocationRequest.view":
      // The department that asked sees its own ask; Finance and administrators see
      // the queue they have to answer.
      return finance || management || superAdmin || own;

    case "reimbursement.view":
      return finance || management || (hod && own) || resource.submitterId === actor.id;

    case "vendor.view":
      return finance || management || superAdmin || hod;
    case "vendor.bankDetails.view":
      // Full account numbers only for Finance and Management; masked for HODs (20.7).
      return finance || management;
    case "vendorRequest.view":
      return finance || management || superAdmin || (hod && own);

    case "income.view":
      // Reading, not recording. `income.manage` and `vendor.manage` stay with Finance,
      // so an administrator sees the ledgers — and the close-out pack built from them
      // — without gaining the authority to change what is in them.
      return finance || management || superAdmin;

    case "ticket.view":
      return finance || management || partyToTicket(actor, resource);

    case "flag.view":
      return finance || superAdmin || (hod && own);

    case "audit.view":
    case "closeOut.view":
    case "superAdmin.manage":
      // Oversight, not spending. The audit log is every action anyone took and the
      // close-out pack is the whole fest's finances in one download, so both answer
      // to the administrator flag rather than to a role — an HOD running their own
      // department has no call on either. `superAdmin.manage` sits here too: if any
      // Finance HOD could appoint administrators, the flag would draw no boundary.
      return isSuperAdmin(actor);

    case "export.run":
      // 20.12's rules, plus the administrator: Management needs the payment batch to
      // make transfers and an HOD their own department's statement, and an
      // administrator needs every department's — they are the one who signs the fest
      // off. Without this the close-out pack would render for them and every
      // download inside it would refuse. Which kinds each may pull is decided per
      // export in `lib/services/exports.ts`.
      return finance || management || superAdmin || (hod && own);

    /* --------------------------------------------------------------- budget */
    case "allocationRequest.create":
      // An HOD asks for their own department's allocation and nobody else's. The ask
      // is not the money: approving it is a `budget.transfer`, which stays with
      // Finance and administrators, so 5.2's segregation is untouched — a department
      // still cannot hand itself a rupee.
      return hod && own;

    case "allocationRequest.decide":
      // Whoever may move an allocation may answer a request for one. Same people as
      // `budget.transfer` on purpose: the approval *performs* the transfer.
      return finance || superAdmin;

    case "budget.transfer":
      // Allocating a department's budget. Finance does it as the money's custodian;
      // an administrator because they own the fest's shape. Both leave the same audit
      // trail — an allocation only ever moves by transfer, with a reason (7.1).
      return finance || superAdmin;

    case "fest.manage":
    case "department.manage":
    case "lineItem.markReviewed":
    case "user.manage":
    case "expenseType.manage":
    case "income.manage":
    case "flag.resolve":
      return finance;

    case "lineItem.create":
    case "lineItem.edit":
    case "lineItem.close":
    case "lineItem.document.manage":
      // An administrator breaks down any department's allocation, the same way they
      // read any department's numbers. The department cap still binds them — it is
      // enforced under a row lock in the service, not by who they are.
      return finance || superAdmin || (hod && own);

    /* ---------------------------------------------------------------- money */
    case "reimbursement.create":
      return true; // every role may claim money they personally spent (5.1)

    case "reimbursement.edit":
      return (
        resource.submitterId === actor.id &&
        (resource.status === "DRAFT" || resource.status === "SENT_BACK")
      );

    case "reimbursement.endorse":
      // Dept HOD of the request's department; Finance may override, and it is logged.
      return resource.submitterId !== actor.id && (finance || (hod && own));

    case "reimbursement.approve":
      // 5.2: a Finance HOD's own request is approved by Management instead.
      if (resource.submitterId === actor.id) return false;
      return resource.submitterRole === "FINANCE_HOD" ? management : finance;

    case "reimbursement.hold":
      return management;

    case "reimbursement.recordPayment":
      // Management records payment, and never for their own request (5.2).
      return management && resource.submitterId !== actor.id;

    case "vendor.manage":
      return finance || hod;

    case "vendor.delete":
      // Narrower than editing on purpose. A vendor carries the payment trail for
      // every request raised against it, so retiring one is the custodian's call —
      // and the service still refuses while any request is live.
      return finance || superAdmin;

    case "vendorRequest.create":
      // An HOD raises vendor requests against their own department's line items only.
      return finance || (hod && own);

    case "vendorRequest.edit":
      return (
        resource.submitterId === actor.id &&
        (resource.status === "DRAFT" || resource.status === "SENT_BACK")
      );

    case "vendorRequest.approve":
      return finance && resource.submitterId !== actor.id;

    case "vendorRequest.confirmDelivery":
      return finance || (hod && own);

    case "vendorRequest.recordPayment":
      return management;

    /* -------------------------------------------------------------- tickets */
    case "ticket.create":
      return true;

    case "ticket.triage":
      // The target department's HOD. Finance HOD triages tickets addressed to Finance.
      return (finance || hod) && resource.targetDepartmentId === actor.departmentId;

    case "ticket.work":
      return (
        resource.assigneeId === actor.id ||
        ((finance || hod) && resource.targetDepartmentId === actor.departmentId)
      );

    case "ticket.plan":
      // Labels, projects and cycles are how a board is sliced, not who may spend.
      // Anyone who runs work — an HOD, Finance, Management, an administrator —
      // shapes them; a Member uses them.
      return finance || management || superAdmin || hod;

    case "ticket.close":
      return (
        resource.requesterId === actor.id ||
        (hod && resource.requestingDepartmentId === actor.departmentId) ||
        finance
      );

    /* ------------------------------------------------------------- comments */
    case "flag.raise":
      // Raising a concern by hand (8.3). Deliberately wider than `flag.resolve`:
      // the person who notices something is rarely the person who clears it, and an
      // HOD watching their own department is exactly who notices first. What may be
      // flagged is decided by whether the caller can see it, in the service.
      return finance || management || superAdmin || hod;

    case "comment.create":
      // Anyone who can see the entity may comment on it (7.6). Callers pass the
      // entity's own view action through `canComment` below.
      return true;
  }
}

/**
 * "May they do this fest-wide, or only for their own department?"
 *
 * Asking `can` with no department in the resource answers it: the own-department
 * clause cannot match, so only the roles with fest-wide reach return true. List
 * endpoints use this to decide whether to add a department filter, which keeps the
 * scoping decision inside `can` rather than duplicating role checks in queries.
 */
export function canFestWide(actor: Actor, action: Action): boolean {
  return can(actor, action, { festId: actor.festId });
}

export class Forbidden extends Error {
  readonly code = "FORBIDDEN";
  constructor(action: Action) {
    super(`Not permitted: ${action}`);
    this.name = "Forbidden";
  }
}

export function assertCan(actor: Actor, action: Action, resource: Resource = {}): void {
  if (!can(actor, action, resource)) throw new Forbidden(action);
}

/** 7.6 — commenting follows visibility of the parent entity. */
export function canComment(actor: Actor, viewAction: Action, resource: Resource = {}): boolean {
  return can(actor, viewAction, resource);
}

/**
 * The actor constraints carried on state-machine transitions (5.2).
 * `can` handles role and department; this handles "who exactly".
 */
export function satisfiesActorConstraints(
  constraints: readonly ActorConstraint[] | undefined,
  actor: Actor,
  resource: Resource,
): boolean {
  for (const c of constraints ?? []) {
    switch (c) {
      case "SUBMITTER":
        if ((resource.submitterId ?? resource.requesterId) !== actor.id) return false;
        break;
      case "NOT_SUBMITTER":
        if ((resource.submitterId ?? resource.requesterId) === actor.id) return false;
        break;
      case "TARGET_DEPT_HOD":
        if (actor.role !== "DEPT_HOD" && actor.role !== "FINANCE_HOD") return false;
        if ((resource.targetDepartmentId ?? resource.departmentId) !== actor.departmentId) return false;
        break;
      case "REQUESTING_DEPT_HOD":
        if (actor.role !== "DEPT_HOD" && actor.role !== "FINANCE_HOD") return false;
        if (resource.requestingDepartmentId !== actor.departmentId) return false;
        break;
      case "ASSIGNEE":
        if (resource.assigneeId !== actor.id) return false;
        break;
      case "REQUESTER":
        if (resource.requesterId !== actor.id) return false;
        break;
    }
  }
  return true;
}

/** Account numbers are masked for anyone who may not see them in full (20.7). */
export function maskAccountNumber(value: string | null): string | null {
  if (!value) return value;
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}
