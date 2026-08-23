import { z } from "zod";
import { parseQuery, route } from "@/lib/api";
import { groupByPayee, paymentQueue } from "@/lib/queries/queues";

const query = z.object({ group: z.enum(["payee", "none"]).optional() });

/**
 * PRD 20.11 — what Management works from when making transfers. Grouped by payee by
 * default, because one person owed three things gets one transfer, not three.
 */
export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, query);
  const items = await paymentQueue(user);
  return q.group === "none"
    ? { data: items, next_cursor: null }
    : { data: groupByPayee(items), next_cursor: null };
});
