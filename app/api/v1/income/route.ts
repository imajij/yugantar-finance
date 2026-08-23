import { z } from "zod";
import { parseBody, parseQuery, route } from "@/lib/api";
import { createIncome, incomeLedger } from "@/lib/services/income";

const listQuery = z.object({
  type: z.enum(["SPONSORSHIP_CASH", "SPONSORSHIP_IN_KIND", "EVENT_TICKETS", "COLLEGE_GRANT", "OTHER"]).optional(),
  status: z.enum(["PLEDGED", "PARTIALLY_RECEIVED", "RECEIVED", "WRITTEN_OFF"]).optional(),
  overdue: z.enum(["0", "1"]).optional(),
});

export const GET = route(async ({ user, request }) => {
  const f = parseQuery(request, listQuery);
  return { data: await incomeLedger(user, { type: f.type, status: f.status, overdue: f.overdue === "1" }), next_cursor: null };
});

const schema = z.object({
  type: z.enum(["SPONSORSHIP_CASH", "SPONSORSHIP_IN_KIND", "EVENT_TICKETS", "COLLEGE_GRANT", "OTHER"]),
  source_name: z.string().min(2).max(160),
  owning_department_id: z.uuid().nullish(),
  pledged_paise: z.number().int().min(0).default(0),
  pledged_on: z.iso.date().nullish(),
  notes: z.string().max(1000).nullish(),
  attachment_ids: z.array(z.uuid()).max(10).optional(),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createIncome(user, {
    type: b.type, sourceName: b.source_name, owningDepartmentId: b.owning_department_id,
    pledgedPaise: b.pledged_paise, pledgedOn: b.pledged_on, notes: b.notes, attachmentIds: b.attachment_ids,
  });
});
