import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { resolveFlag, withdrawFlag } from "@/lib/services/flags";

const schema = z.object({
  action: z.enum(["ACKNOWLEDGE", "DISMISS", "WITHDRAW"]),
  // 8.3: acknowledging without saying why is the same as ignoring it.
  note: z.string().min(3).max(1000).optional(),
  reason: z.string().min(3).max(1000).optional(),
});

/**
 * PRD 20.10 — Finance acknowledges or dismisses. Both are audited with the note.
 *
 * WITHDRAW is the third answer and belongs to whoever raised the concern by hand:
 * they may take it back, and nobody else's flag.
 */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  const note = b.note ?? b.reason ?? "";
  if (b.action === "WITHDRAW") return withdrawFlag(user, params.id, note);
  return resolveFlag(user, params.id, b.action, note);
}, { idempotent: true });
