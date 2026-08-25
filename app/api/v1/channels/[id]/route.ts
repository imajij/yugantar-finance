import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { addableMembers, archiveChannel, getChannel, updateChannel } from "@/lib/services/chat";

/**
 * Opening a channel.
 *
 * For an administrator who is not a member this also writes `channel.oversight_read`
 * to the audit log — see `lib/services/chat.ts`. The response says
 * `administrators_can_read`, which the UI shows to everyone in the channel rather
 * than only to the administrator.
 */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const channel = await getChannel(user, params.id);
  return {
    id: channel.id,
    kind: channel.kind,
    name: channel.displayName,
    topic: channel.topic,
    department_id: channel.departmentId,
    is_default: channel.isDefault,
    is_member: channel.isMember,
    // Named for what it is rather than for who is doing it: the UI shows this to
    // everybody in the channel, not only to the administrator reading it.
    is_oversight_read: channel.isOversight,
    administrators_can_read: channel.administratorsCanRead,
    archived: channel.archivedAt !== null,
    members: channel.members,
    addable: await addableMembers(user, params.id),
  };
});

const patch = z.object({
  name: z.string().min(2).max(40).optional(),
  topic: z.string().max(200).nullish(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, patch);
  return updateChannel(user, params.id, { name: b.name, topic: b.topic });
});

/** Archiving, not deleting: what was said stays readable, nothing new can be added. */
export const DELETE = route<{ id: string }>(async ({ user, params }) => archiveChannel(user, params.id));
