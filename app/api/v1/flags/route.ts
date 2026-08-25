import { z } from "zod";
import { parseBody, parseQuery, route } from "@/lib/api";
import { listFlags, raiseFlag } from "@/lib/services/flags";

const query = z.object({
  status: z.enum(["OPEN", "ACKNOWLEDGED", "DISMISSED"]).optional(),
  entity_type: z.enum(["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM", "DEPARTMENT", "USER"]).optional(),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  source: z.enum(["MANUAL", "RULE"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** PRD 20.10 — open flags, worst and oldest first. Finance sees all; an HOD their own. */
export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, query);
  const data = await listFlags(user, {
    status: q.status, entityType: q.entity_type, severity: q.severity,
    source: q.source, limit: q.limit,
  });
  return { data, next_cursor: null };
});

const raise = z.object({
  entity_type: z.enum(["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM", "DEPARTMENT", "USER"]),
  entity_id: z.uuid(),
  severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
  explanation: z.string().min(10).max(1000),
});

/** Raising a concern by hand — a person noticing what no rule looks for (8.3). */
export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, raise);
  return raiseFlag(user, {
    entityType: b.entity_type, entityId: b.entity_id,
    severity: b.severity, explanation: b.explanation,
  });
});
