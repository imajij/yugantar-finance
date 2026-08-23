import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { markRead } from "@/lib/services/notifications";

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, z.object({ ids: z.array(z.uuid()).max(200).optional() }));
  return markRead(user, b.ids);
});
