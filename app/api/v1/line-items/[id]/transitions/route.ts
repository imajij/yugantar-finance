import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { LINE_ITEM_ACTIONS } from "@/lib/state-machines/line-item";
import { transitionLineItem } from "@/lib/services/line-items";

const schema = z.object({
  action: z.enum(LINE_ITEM_ACTIONS),
  reason: z.string().max(300).optional(),
});

/** PRD 20.5 — CLOSE, REOPEN (reason required), MARK_REVIEWED, UNMARK_REVIEWED. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const { action, ...rest } = await parseBody(request, schema);
  return transitionLineItem(user, params.id, action, rest);
}, { idempotent: true });
