import { and, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { departments, lineItems, vendorRequests, vendors } from "@/db/schema";
import { assertCan, canFestWide } from "@/lib/authz";
import { page, parseBody, parseQuery, route } from "@/lib/api";
import { createVendorRequest } from "@/lib/services/vendors";
import { VENDOR_STATES } from "@/lib/state-machines/vendor";

const listQuery = z.object({
  status: z.string().optional(),
  department_id: z.uuid().optional(),
  vendor_id: z.uuid().optional(),
  overdue: z.enum(["0", "1"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** PRD 20.7 — H sees their own department; F and Mg see all. A Member sees none. */
export const GET = route(async ({ user, request }) => {
  assertCan(user, "vendorRequest.view", { festId: user.festId, departmentId: user.departmentId });
  const f = parseQuery(request, listQuery);
  const seesAll = canFestWide(user, "vendorRequest.view");
  const statuses = f.status?.split(",").filter((s) => (VENDOR_STATES as readonly string[]).includes(s));

  const rows = await db
    .select({
      id: vendorRequests.id,
      human_id: vendorRequests.humanId,
      status: vendorRequests.status,
      description: vendorRequests.description,
      total_value_paise: vendorRequests.totalValuePaise,
      approved_value_paise: vendorRequests.approvedValuePaise,
      expected_delivery_on: vendorRequests.expectedDeliveryOn,
      delivered_at: vendorRequests.deliveredAt,
      vendor: vendors.name,
      department: departments.name,
      line_item: lineItems.name,
      paid_paise: sql<number>`(select coalesce(sum(paid_paise), 0) from vendor_milestones
        where vendor_request_id = ${vendorRequests.id})`.mapWith(Number),
      flag_count: sql<number>`(select count(*) from flags
        where flags.entity_type = 'VENDOR_REQUEST' and flags.entity_id = ${vendorRequests.id}
          and flags.status = 'OPEN')`.mapWith(Number),
    })
    .from(vendorRequests)
    .innerJoin(vendors, eq(vendors.id, vendorRequests.vendorId))
    .innerJoin(departments, eq(departments.id, vendorRequests.departmentId))
    .innerJoin(lineItems, eq(lineItems.id, vendorRequests.lineItemId))
    .where(and(
      eq(vendorRequests.festId, user.festId),
      isNull(vendorRequests.deletedAt),
      seesAll ? undefined : eq(vendorRequests.departmentId, user.departmentId),
      statuses?.length ? inArray(vendorRequests.status, statuses as never[]) : undefined,
      f.department_id ? eq(vendorRequests.departmentId, f.department_id) : undefined,
      f.vendor_id ? eq(vendorRequests.vendorId, f.vendor_id) : undefined,
      f.overdue === "1"
        ? and(lt(vendorRequests.expectedDeliveryOn, sql`current_date`), isNull(vendorRequests.deliveredAt))
        : undefined,
    ))
    .orderBy(desc(vendorRequests.createdAt))
    .limit(f.limit + 1);

  return page(rows, f.limit, (r) => r.id);
});

const createSchema = z.object({
  vendor_id: z.uuid(),
  line_item_id: z.uuid(),
  description: z.string().min(5).max(1000),
  total_value_paise: z.number().int().positive(),
  milestones: z.array(z.object({
    kind: z.enum(["ADVANCE", "BALANCE", "OTHER"]),
    planned_paise: z.number().int().min(0),
  })).min(1).max(6),
  expected_delivery_on: z.iso.date().nullish(),
  attachment_ids: z.array(z.uuid()).max(10).optional(),
  submit: z.boolean().default(false),
});

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, createSchema);
  return createVendorRequest(user, {
    vendorId: b.vendor_id,
    lineItemId: b.line_item_id,
    description: b.description,
    totalValuePaise: b.total_value_paise,
    milestones: b.milestones.map((m) => ({ kind: m.kind, plannedPaise: m.planned_paise })),
    expectedDeliveryOn: b.expected_delivery_on,
    attachmentIds: b.attachment_ids,
    submit: b.submit,
  });
}, { idempotent: true });
