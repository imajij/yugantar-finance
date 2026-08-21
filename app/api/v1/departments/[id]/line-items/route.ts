import { z } from "zod";
import { route, parseBody } from "@/lib/api";
import { createLineItem } from "@/lib/services/line-items";

const schema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).nullish(),
  planned_paise: z.number().int().positive(),
  default_expense_type_id: z.uuid().nullish(),
  attachment_ids: z.array(z.uuid()).max(10).optional(),
});

/** PRD 20.5 — OVER_ALLOCATION if Σ line items would exceed the department allocation. */
export const POST = route<{ id: string }>(async ({ user, params, request }) => {
  const body = await parseBody(request, schema);
  return createLineItem(user, {
    departmentId: params.id,
    name: body.name,
    description: body.description,
    plannedPaise: body.planned_paise,
    defaultExpenseTypeId: body.default_expense_type_id,
    attachmentIds: body.attachment_ids,
  });
});
