import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { vendorRequests, vendors } from "@/db/schema";
import { assertCan } from "@/lib/authz";
import { notFound, parseBody, route } from "@/lib/api";
import { deleteVendor, redactVendor, updateVendor, vendorExposure } from "@/lib/services/vendors";

export const GET = route<{ id: string }>(async ({ user, params }) => {
  assertCan(user, "vendor.view", { festId: user.festId });
  const [vendor] = await db.select().from(vendors)
    .where(and(eq(vendors.id, params.id), eq(vendors.festId, user.festId), isNull(vendors.deletedAt))).limit(1);
  if (!vendor) throw notFound("Vendor");

  const [exposure] = await vendorExposure(user.festId, vendor.id);
  const requests = await db.select().from(vendorRequests)
    .where(and(eq(vendorRequests.vendorId, vendor.id), isNull(vendorRequests.deletedAt)))
    .orderBy(desc(vendorRequests.createdAt));

  return {
    vendor: redactVendor(user, vendor),
    exposure,
    requests: requests.map((r) => ({
      id: r.id, human_id: r.humanId, status: r.status, description: r.description,
      total_value_paise: r.totalValuePaise, approved_value_paise: r.approvedValuePaise,
      expected_delivery_on: r.expectedDeliveryOn,
    })),
  };
});

const schema = z.object({
  name: z.string().min(2).max(120).optional(),
  contact_name: z.string().max(120).nullish(),
  phone: z.string().max(20).nullish(),
  email: z.email().nullish(),
  bank_account_name: z.string().max(120).nullish(),
  bank_account_number: z.string().max(30).nullish(),
  bank_ifsc: z.string().max(15).nullish(),
  upi_id: z.string().max(80).nullish(),
  gstin: z.string().max(20).nullish(),
  notes: z.string().max(1000).nullish(),
});

export const PATCH = route<{ id: string }>(async ({ user, params, request }) => {
  const b = await parseBody(request, schema);
  return updateVendor(user, params.id, {
    name: b.name, contactName: b.contact_name, phone: b.phone, email: b.email,
    bankAccountName: b.bank_account_name, bankAccountNumber: b.bank_account_number,
    bankIfsc: b.bank_ifsc, upiId: b.upi_id, gstin: b.gstin, notes: b.notes,
  });
});

/**
 * Retiring a vendor. Soft, audited, and refused while any request against it is
 * still live — see `deleteVendor`.
 */
export const DELETE = route<{ id: string }>(async ({ user, params, request }) => {
  const reason = new URL(request.url).searchParams.get("reason") ?? undefined;
  return deleteVendor(user, params.id, reason);
});
