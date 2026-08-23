import { z } from "zod";
import { parseBody, parseQuery, route } from "@/lib/api";
import { addComment, listComments, type CommentableType } from "@/lib/services/comments";

const TYPES = ["REIMBURSEMENT", "VENDOR_REQUEST", "TICKET", "LINE_ITEM", "INCOME_ENTRY"] as const;

export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, z.object({ entity_type: z.enum(TYPES), entity_id: z.uuid() }));
  return { data: await listComments(user, q.entity_type as CommentableType, q.entity_id) };
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, z.object({
    entity_type: z.enum(TYPES),
    entity_id: z.uuid(),
    body: z.string().min(1).max(2000),
  }));
  return addComment(user, b.entity_type as CommentableType, b.entity_id, b.body);
});
