import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { resolveFlag } from "@/lib/services/flags";

const schema = z.object({
  action: z.enum(["ACKNOWLEDGE", "DISMISS"]),
  // 8.3: acknowledging without saying why is the same as ignoring it.
  note: z.string().min(3).max(1000).optional(),
  reason: z.string().min(3).max(1000).optional(),
});

/** PRD 20.10 — Finance acknowledges or dismisses. Both are audited with the note. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return resolveFlag(user, params.id, b.action, b.note ?? b.reason ?? "");
}, { idempotent: true });
