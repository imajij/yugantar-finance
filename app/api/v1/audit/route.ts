import { z } from "zod";
import { parseQuery, route } from "@/lib/api";
import { readAuditLog } from "@/lib/services/audit";

const query = z.object({
  entity_type: z.enum([
    "REIMBURSEMENT", "VENDOR_REQUEST", "VENDOR", "TICKET",
    "LINE_ITEM", "INCOME_ENTRY", "DEPARTMENT", "USER", "FEST",
    // CHANNEL carries `channel.oversight_read` — who has been reading whose
    // conversations. Filterable on purpose: the oversight has to be reviewable.
    "CHANNEL", "ALLOCATION_REQUEST", "PROJECT", "CYCLE", "TICKET_LABEL",
  ]).optional(),
  entity_id: z.uuid().optional(),
  actor_id: z.uuid().optional(),
  action: z.string().max(100).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * PRD 20.10 — both forms of the audit read: one entity's timeline, or the fest-wide
 * log for a date range. Finance and Management see everything; a Dept HOD their own.
 */
export const GET = route(async ({ user, request }) => {
  const q = parseQuery(request, query);
  const data = await readAuditLog(user, {
    entityType: q.entity_type, entityId: q.entity_id, actorId: q.actor_id,
    action: q.action, from: q.from, to: q.to, limit: q.limit,
  });
  return { data, next_cursor: null };
});
