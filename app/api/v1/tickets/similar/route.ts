import { z } from "zod";
import { parseQuery, route } from "@/lib/api";
import { similarTickets } from "@/lib/services/tickets";

const query = z.object({
  target_department_id: z.uuid(),
  title: z.string().min(1).max(200),
});

/** PRD 20.9 — up to five open tickets with similar titles, shown while typing a new one. */
export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, query);
  return { data: await similarTickets(user, q.target_department_id, q.title), next_cursor: null };
});
