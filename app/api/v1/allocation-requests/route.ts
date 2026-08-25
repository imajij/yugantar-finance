import { z } from "zod";
import { parseBody, route } from "@/lib/api";
import { createAllocationRequest, listAllocationRequests } from "@/lib/services/allocations";

const STATUSES = ["PENDING", "APPROVED", "DECLINED", "WITHDRAWN"] as const;

/** An HOD's ask for a bigger (or smaller) allocation — PRD 7.1. */
export const GET = route(async ({ user, request }) => {
  const url = new URL(request.url);
  const status = STATUSES.find((s) => s === url.searchParams.get("status"));
  const departmentId = url.searchParams.get("department_id") ?? undefined;
  return { data: await listAllocationRequests(user, { status, departmentId }) };
});

const schema = z.object({
  department_id: z.uuid(),
  requested_paise: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  reason: z.string().min(10).max(1000),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createAllocationRequest(user, {
    departmentId: b.department_id,
    requestedPaise: b.requested_paise,
    reason: b.reason,
  });
});
