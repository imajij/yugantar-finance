import { and, asc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { vendors } from "@/db/schema";
import { assertCan } from "@/lib/authz";
import { parseBody, route } from "@/lib/api";
import { createVendor, redactVendor, vendorExposure } from "@/lib/services/vendors";

/** PRD 20.7 — vendors are shared across departments so Finance sees total exposure. */
export const GET = route(async ({ user }) => {
  assertCan(user, "vendor.view", { festId: user.festId });
  const [rows, exposure] = await Promise.all([
    db.select().from(vendors)
      .where(and(eq(vendors.festId, user.festId), isNull(vendors.deletedAt)))
      .orderBy(asc(vendors.name)),
    vendorExposure(user.festId),
  ]);
  const byId = new Map(exposure.map((e) => [e.vendorId, e]));

  return {
    data: rows.map((v) => {
      const e = byId.get(v.id);
      const safe = redactVendor(user, v);
      return {
        id: safe.id, name: safe.name, contact_name: safe.contactName, phone: safe.phone,
        upi_id: safe.upiId, bank_account_number: safe.bankAccountNumber, bank_ifsc: safe.bankIfsc,
        gstin: safe.gstin,
        contracted_paise: e?.contractedPaise ?? 0,
        paid_paise: e?.paidPaise ?? 0,
        outstanding_paise: e?.outstandingPaise ?? 0,
        request_count: e?.requestCount ?? 0,
      };
    }),
    next_cursor: null,
  };
});

const schema = z.object({
  name: z.string().min(2).max(120),
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

export const POST = route(async ({ user, request }) => {
  const b = await parseBody(request, schema);
  return createVendor(user, {
    name: b.name, contactName: b.contact_name, phone: b.phone, email: b.email,
    bankAccountName: b.bank_account_name, bankAccountNumber: b.bank_account_number,
    bankIfsc: b.bank_ifsc, upiId: b.upi_id, gstin: b.gstin, notes: b.notes,
  });
});
