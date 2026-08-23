/**
 * Comments (PRD 7.6). One thread per entity, visible to whoever can see the entity.
 * @mentions notify; nothing else does.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { commentMentions, comments, users } from "@/db/schema";
import { ApiError, notFound } from "@/lib/api";
import { canComment, type Action } from "@/lib/authz";
import type { SessionUser } from "@/lib/session";
import { notify } from "./notifications";

export type CommentableType = "REIMBURSEMENT" | "VENDOR_REQUEST" | "TICKET" | "LINE_ITEM" | "INCOME_ENTRY";

const VIEW_ACTION: Record<CommentableType, Action> = {
  REIMBURSEMENT: "reimbursement.view",
  VENDOR_REQUEST: "vendorRequest.view",
  TICKET: "ticket.view",
  LINE_ITEM: "lineItem.view",
  INCOME_ENTRY: "income.view",
};

/** Resolves the parent so visibility is checked against the real row, not the caller's claim. */
async function parentResource(actor: SessionUser, type: CommentableType, id: string) {
  const table = {
    REIMBURSEMENT: "reimbursement_requests", VENDOR_REQUEST: "vendor_requests",
    TICKET: "tickets", LINE_ITEM: "line_items", INCOME_ENTRY: "income_entries",
  }[type];

  const [row] = (await db.execute(sql`
    select ${type === "TICKET" ? sql`requesting_department_id` : sql`department_id`} as department_id,
           ${type === "TICKET" ? sql`target_department_id` : sql`null::uuid`}        as target_department_id,
           ${type === "TICKET" ? sql`requester_id`
             : type === "REIMBURSEMENT" ? sql`requester_id`
             : type === "VENDOR_REQUEST" ? sql`requested_by`
             : sql`null::uuid`}                                                       as submitter_id,
           ${type === "TICKET" ? sql`assignee_id` : sql`null::uuid`}                  as assignee_id
      from ${sql.raw(table)}
     where id = ${id} and fest_id = ${actor.festId}
  `)) as unknown as Record<string, string | null>[];
  if (!row) throw notFound(type.toLowerCase().replace("_", " "));

  return {
    festId: actor.festId,
    departmentId: row.department_id ?? undefined,
    targetDepartmentId: row.target_department_id ?? undefined,
    submitterId: row.submitter_id ?? undefined,
    assigneeId: row.assignee_id ?? undefined,
  };
}

const MENTION = /@([a-z0-9._-]+@[a-z0-9.-]+)/gi;

export async function addComment(
  actor: SessionUser, type: CommentableType, entityId: string, body: string,
) {
  const resource = await parentResource(actor, type, entityId);
  if (!canComment(actor, VIEW_ACTION[type], resource)) {
    throw new ApiError("FORBIDDEN", "You cannot comment on this");
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(comments).values({
      festId: actor.festId, entityType: type, entityId, authorId: actor.id, body,
    }).returning();

    const emails = [...body.matchAll(MENTION)].map((m) => m[1].toLowerCase());
    if (emails.length) {
      const mentioned = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.festId, actor.festId), inArray(sql`lower(${users.email})`, emails)));
      const ids = mentioned.map((u) => u.id).filter((id) => id !== actor.id);
      if (ids.length) {
        await tx.insert(commentMentions).values(ids.map((userId) => ({ commentId: row.id, userId })));
        await notify(tx, {
          festId: actor.festId, type: "comment.mention", entityType: type, entityId,
          title: `${actor.name} mentioned you`, body: body.slice(0, 200), toUsers: ids,
        });
      }
    }
    return { ...row, author: actor.name };
  });
}

export async function listComments(actor: SessionUser, type: CommentableType, entityId: string) {
  const resource = await parentResource(actor, type, entityId);
  if (!canComment(actor, VIEW_ACTION[type], resource)) {
    throw new ApiError("FORBIDDEN", "You cannot see this thread");
  }
  return db
    .select({
      id: comments.id, body: comments.body, author: users.name,
      authorId: comments.authorId, createdAt: comments.createdAt, editedAt: comments.editedAt,
    })
    .from(comments).innerJoin(users, eq(users.id, comments.authorId))
    .where(and(eq(comments.entityType, type), eq(comments.entityId, entityId)))
    .orderBy(asc(comments.createdAt));
}

/** Authors may edit their own comment; nobody edits anyone else's (7.6). */
export async function editComment(actor: SessionUser, id: string, body: string) {
  const [row] = await db.update(comments)
    .set({ body, editedAt: new Date() })
    .where(and(eq(comments.id, id), eq(comments.authorId, actor.id), eq(comments.festId, actor.festId)))
    .returning();
  if (!row) throw notFound("Comment");
  return row;
}
