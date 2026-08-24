import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { evaluateFor } from "@/lib/services/flags";

const schema = z.object({
  entity_type: z.enum(["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM"]),
  entity_id: z.uuid(),
});

/** PRD 20.10 — re-runs the rule set for one record. Idempotent by construction. */
export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return evaluateFor(user, b.entity_type, b.entity_id);
});
