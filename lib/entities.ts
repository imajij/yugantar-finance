/**
 * One place that turns an (entity type, id) pair into the `Resource` that `can()`
 * needs (PRD 18.2 rule 1).
 *
 * Comments, attachments, flags and the audit timeline all answer the same question —
 * "may this caller see that record?" — and all of them must answer it from the row
 * itself, never from what the client claimed. Keeping the mapping here means a new
 * entity is one entry, not four near-identical queries that can drift apart.
 */
import { sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { notFound } from "@/lib/api";
import type { Action, Resource } from "@/lib/authz";

export type EntityType =
  | "REIMBURSEMENT" | "VENDOR_REQUEST" | "VENDOR" | "TICKET"
  | "LINE_ITEM" | "INCOME_ENTRY" | "DEPARTMENT" | "USER" | "FEST"
  /**
   * A chat message is here so attachments can name their parent, but it is the one
   * type this module cannot resolve: its audience is a channel membership row and
   * the caller's own id, neither of which fits a `Resource`. Callers must ask
   * `lib/services/chat.ts` instead — `resolveEntity` throws for it on purpose,
   * rather than answering with a resource that would quietly grant access.
   */
  | "MESSAGE";

export const VIEW_ACTION: Record<EntityType, Action> = {
  REIMBURSEMENT: "reimbursement.view",
  VENDOR_REQUEST: "vendorRequest.view",
  VENDOR: "vendor.view",
  TICKET: "ticket.view",
  LINE_ITEM: "lineItem.view",
  INCOME_ENTRY: "income.view",
  DEPARTMENT: "department.view",
  USER: "user.manage",
  FEST: "fest.view",
  // Never reached: `resolveEntity` refuses MESSAGE before a caller gets this far.
  MESSAGE: "channel.view",
};

/**
 * The columns each table uses for the same concept. Reimbursements call their
 * author `submitter_id`, vendor requests `requested_by`, tickets `requester_id`;
 * `can()` only knows about "the submitter", so the translation happens here.
 */
const SHAPES: Record<EntityType, {
  table: string;
  department?: string;
  targetDepartment?: string;
  requestingDepartment?: string;
  submitter?: string;
  assignee?: string;
  status?: string;
  softDeleted?: boolean;
}> = {
  REIMBURSEMENT: { table: "reimbursement_requests", department: "department_id", submitter: "submitter_id", status: "status", softDeleted: true },
  VENDOR_REQUEST: { table: "vendor_requests", department: "department_id", submitter: "requested_by", status: "status", softDeleted: true },
  VENDOR: { table: "vendors", softDeleted: true },
  TICKET: { table: "tickets", requestingDepartment: "requesting_department_id", targetDepartment: "target_department_id", submitter: "requester_id", assignee: "assignee_id", status: "status", softDeleted: true },
  LINE_ITEM: { table: "line_items", department: "department_id", status: "status", softDeleted: true },
  INCOME_ENTRY: { table: "income_entries", department: "owning_department_id", status: "status", softDeleted: true },
  DEPARTMENT: { table: "departments", department: "id" },
  USER: { table: "users", department: "department_id" },
  FEST: { table: "fests" },
  MESSAGE: { table: "messages" },
};

/** The submitter's role, which reimbursement approval routing turns on (5.2). */
const NEEDS_SUBMITTER_ROLE: EntityType[] = ["REIMBURSEMENT"];

export interface ResolvedEntity extends Resource {
  /** Present so callers can label a notification without a second query. */
  humanId?: string;
}

export async function resolveEntity(
  festId: string, type: EntityType, id: string, tx?: Tx,
): Promise<ResolvedEntity> {
  if (type === "MESSAGE") {
    // Deliberately unreachable rather than best-effort. A message's audience is a
    // channel membership row; answering with a department-shaped resource here
    // would hand `can()` a question it cannot get right, and it would fail open.
    throw new Error("A message's visibility is a channel membership — ask lib/services/chat.ts");
  }
  const shape = SHAPES[type];
  const runner = tx ?? db;
  const col = (name: string | undefined) => (name ? sql.raw(`e.${name}`) : sql`null`);

  const [row] = (await runner.execute(sql`
    select ${col(shape.department)}             as department_id,
           ${col(shape.targetDepartment)}       as target_department_id,
           ${col(shape.requestingDepartment)}   as requesting_department_id,
           ${col(shape.submitter)}              as submitter_id,
           ${col(shape.assignee)}               as assignee_id,
           ${shape.status ? sql.raw(`e.${shape.status}::text`) : sql`null`} as status,
           ${sql.raw(hasHumanId(type) ? "e.human_id" : "null")}             as human_id,
           ${NEEDS_SUBMITTER_ROLE.includes(type) && shape.submitter
             ? sql.raw(`(select u.role::text from users u where u.id = e.${shape.submitter})`)
             : sql`null`}                       as submitter_role
      from ${sql.raw(shape.table)} e
     where e.id = ${id}
       and ${type === "FEST" ? sql.raw("e.id") : sql.raw("e.fest_id")} = ${festId}
       ${shape.softDeleted ? sql.raw("and e.deleted_at is null") : sql.raw("")}
  `)) as unknown as Record<string, string | null>[];

  if (!row) throw notFound(label(type));

  return {
    festId,
    departmentId: row.department_id ?? undefined,
    targetDepartmentId: row.target_department_id ?? undefined,
    requestingDepartmentId: row.requesting_department_id ?? undefined,
    submitterId: row.submitter_id ?? undefined,
    assigneeId: row.assignee_id ?? undefined,
    status: row.status ?? undefined,
    submitterRole: (row.submitter_role as Resource["submitterRole"]) ?? undefined,
    humanId: row.human_id ?? undefined,
  };
}

function hasHumanId(type: EntityType): boolean {
  return type === "REIMBURSEMENT" || type === "VENDOR_REQUEST" || type === "TICKET";
}

export function label(type: EntityType): string {
  return type.toLowerCase().replaceAll("_", " ");
}
