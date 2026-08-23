import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { transitionIncome } from "@/lib/services/income";

const schema = z.object({
  action: z.enum(["WRITE_OFF", "REINSTATE"]),
  reason: z.string().min(3).max(500).optional(),
});

export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return transitionIncome(user, params.id, b.action, b.reason);
}, { idempotent: true });
