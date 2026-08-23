import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { getVendorRequestDetail, updateVendorRequest } from "@/lib/services/vendors";

/** PRD 20.1 — the full record with milestones, files, flags and timeline in one call. */
export const GET = route<{ id: string }>(async ({ user, params }) =>
  getVendorRequestDetail(user, params.id),
);

const patch = z.object({
  description: z.string().min(5).max(500).optional(),
  total_value_paise: z.number().int().positive().optional(),
  expected_delivery_on: z.iso.date().nullable().optional(),
  vendor_id: z.uuid().optional(),
  line_item_id: z.uuid().optional(),
  milestones: z.array(z.object({
    kind: z.enum(["ADVANCE", "BALANCE", "OTHER"]),
    planned_paise: z.number().int().nonnegative(),
  })).min(1).max(10).optional(),
});

/** PRD 20.7 — the requester correcting a request in DRAFT or SENT_BACK. */
export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, patch);
  return updateVendorRequest(user, params.id, {
    description: b.description,
    totalValuePaise: b.total_value_paise,
    expectedDeliveryOn: b.expected_delivery_on,
    vendorId: b.vendor_id,
    lineItemId: b.line_item_id,
    milestones: b.milestones?.map((m) => ({ kind: m.kind, plannedPaise: m.planned_paise })),
  });
});
