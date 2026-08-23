/**
 * Comments (PRD 7.6). One thread per entity, visible to whoever can see the entity.
 * @mentions notify; nothing else does.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { commentMentions, comments, users } from "@/db/schema";
import { ApiError, notFound } from "@/lib/api";
import { canComment } from "@/lib/authz";
import { VIEW_ACTION, resolveEntity, type EntityType } from "@/lib/entities";
import type { SessionUser } from "@/lib/session";
import { notify } from "./notifications";

export type CommentableType = Extract<
  EntityType, "REIMBURSEMENT" | "VENDOR_REQUEST" | "TICKET" | "LINE_ITEM" | "INCOME_ENTRY"
>;

/** PRD 20.10 — an author may correct a typo, not rewrite history an hour later. */
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

/** Resolves the parent so visibility is checked against the real row, not the caller's claim. */
async function assertVisible(actor: SessionUser, type: CommentableType, id: string) {
  const resource = await resolveEntity(actor.festId, type, id);
  if (!canComment(actor, VIEW_ACTION[type], resource)) {
    throw new ApiError("FORBIDDEN", "You cannot see this thread");
  }
  return resource;
}

const MENTION = /@([a-z0-9._-]+@[a-z0-9.-]+)/gi;

export async function addComment(
  actor: SessionUser, type: CommentableType, entityId: string, body: string,
) {
  await assertVisible(actor, type, entityId);

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
  await assertVisible(actor, type, entityId);
  return db
    .select({
      id: comments.id, body: comments.body, author: users.name,
      authorId: comments.authorId, createdAt: comments.createdAt, editedAt: comments.editedAt,
    })
    .from(comments).innerJoin(users, eq(users.id, comments.authorId))
    .where(and(eq(comments.entityType, type), eq(comments.entityId, entityId)))
    .orderBy(asc(comments.createdAt));
}

/**
 * Authors may edit their own comment within five minutes (20.10); nobody edits
 * anyone else's, ever. Past the window the record keeps what was actually said —
 * a comment is often the reason attached to a decision.
 */
export async function editComment(actor: SessionUser, id: string, body: string) {
  const [existing] = await db.select().from(comments)
    .where(and(eq(comments.id, id), eq(comments.festId, actor.festId))).limit(1);
  if (!existing) throw notFound("Comment");
  if (existing.authorId !== actor.id) {
    throw new ApiError("FORBIDDEN", "You can only edit your own comments");
  }
  if (Date.now() - existing.createdAt.getTime() > EDIT_WINDOW_MS) {
    throw new ApiError("VALIDATION_ERROR", "Comments can only be edited within five minutes of posting");
  }

  const [row] = await db.update(comments)
    .set({ body, editedAt: new Date() })
    .where(eq(comments.id, id))
    .returning();
  return row;
}
