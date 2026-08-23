import { z } from "zod";
import { parseQuery, route } from "@/lib/api";
import { inbox, unreadCount } from "@/lib/services/notifications";

export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, z.object({ unread: z.enum(["0", "1"]).optional() }));
  const [data, unread] = await Promise.all([
    inbox(user, { unreadOnly: q.unread === "1" }),
    unreadCount(user),
  ]);
  return { data, unread_count: unread };
});
