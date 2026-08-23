import { z } from "zod";
import { parseQuery, route } from "@/lib/api";
import { listFlags } from "@/lib/services/flags";

const query = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "DISMISSED"]).optional(),
  entity_type: z.enum(["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM"]).optional(),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** PRD 20.10 — open flags, worst and oldest first. Finance sees all; an HOD their own. */
export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, query);
  const data = await listFlags(user, {
    status: q.status, entityType: q.entity_type, severity: q.severity, limit: q.limit,
  });
  return { data, next_cursor: null };
});
