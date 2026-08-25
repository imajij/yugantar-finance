import { z } from "zod";
import { parseBody, parseQuery, route } from "@/lib/api";
import { LINKABLE, listMessages, postMessage } from "@/lib/services/chat";

const query = z.object({
  /** Newer than this — how an open window polls. */
  after: z.iso.datetime().optional(),
  /** Older than this — how scrolling back works. */
  before: z.iso.datetime().optional(),
  /** The replies to one message rather than the channel's top level. */
  parent_id: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = route<{ id: string }>(async ({ user, params, request }) => {
  const q = parseQuery(request, query);
  return {
    data: await listMessages(user, params.id, {
      after: q.after, before: q.before, parentId: q.parent_id, limit: q.limit,
    }),
  };
});

const schema = z.object({
  body: z.string().max(4000).default(""),
  parent_id: z.uuid().nullish(),
  attachment_ids: z.array(z.uuid()).max(5).optional(),
  links: z.array(z.object({
    type: z.enum(LINKABLE as [string, ...string[]]),
    id: z.uuid(),
  })).max(5).optional(),
});

/** Posting needs membership — reading a channel for oversight is not joining it. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return postMessage(user, params.id, {
    body: b.body,
    parentId: b.parent_id,
    attachmentIds: b.attachment_ids,
    links: b.links as { type: (typeof LINKABLE)[number]; id: string }[] | undefined,
  });
});
