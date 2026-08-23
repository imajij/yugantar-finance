import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { sponsorStatement, updateIncome } from "@/lib/services/income";

export const GET = route<{ id: string }>(async ({ user, params }) => sponsorStatement(user, params.id));

const schema = z.object({
  type: z.enum(["SPONSORSHIP_CASH", "SPONSORSHIP_IN_KIND", "EVENT_TICKETS", "COLLEGE_GRANT", "OTHER"]).optional(),
  source_name: z.string().min(2).max(160).optional(),
  owning_department_id: z.uuid().nullish(),
  pledged_paise: z.number().int().min(0).optional(),
  pledged_on: z.iso.date().nullish(),
  notes: z.string().max(1000).nullish(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return updateIncome(user, params.id, {
    type: b.type, sourceName: b.source_name, owningDepartmentId: b.owning_department_id,
    pledgedPaise: b.pledged_paise, pledgedOn: b.pledged_on, notes: b.notes,
  });
});
