import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { backfillChannels, createChannel, listChannels } from "@/lib/services/chat";

/**
 * Every channel the caller may open.
 *
 * Administrators get the whole fest, each row marked `is_member: false` so the UI
 * can say *why* they are seeing it. Everybody else gets the ones they are in, and
 * is told nothing about the existence of any other.
 */
export const GET = route(async ({ user }) => {
  // A fest that predates channels has departments without one, and nobody should
  // have to know that. Idempotent, and cheap once everything exists.
  await backfillChannels(user);
  const rows = await listChannels(user);
  return {
    data: rows.map((c) => ({
      id: c.id, kind: c.kind, name: c.name, topic: c.topic,
      department_id: c.departmentId, department_name: c.departmentName,
      is_default: c.isDefault, is_member: c.isMember, archived: c.archived,
      unread: c.unread, mentions: c.mentions,
      last_message_at: c.lastMessageAt, last_message_preview: c.lastMessagePreview,
      member_count: c.memberCount,
    })),
  };
});

const schema = z.object({
  department_id: z.uuid(),
  name: z.string().min(2).max(40),
  topic: z.string().max(200).nullish(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createChannel(user, { departmentId: b.department_id, name: b.name, topic: b.topic });
});
