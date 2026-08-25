import Link from "next/link";
import { Truck } from "lucide-react";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, vendorRequests, vendors } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can, canFestWide } from "@/lib/authz";
import { redactVendor, vendorExposure } from "@/lib/services/vendors";
import { Amount, Card, Empty, PageTitle, StateChip } from "@/components/ui";

/**
 * PRD 9.4 / 20.7 — vendors are fest-wide, so this screen leads with total exposure:
 * what every department has contracted with a vendor, and what is still owed.
 */
export default async function VendorsPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const [rows, exposure, open] = await Promise.all([
    db.select().from(vendors)
      .where(and(eq(vendors.festId, user.festId), isNull(vendors.deletedAt)))
      .orderBy(asc(vendors.name)),
    vendorExposure(user.festId),
    db.select({
      id: vendorRequests.id, humanId: vendorRequests.humanId, status: vendorRequests.status,
      description: vendorRequests.description, totalValuePaise: vendorRequests.totalValuePaise,
      approvedValuePaise: vendorRequests.approvedValuePaise, vendorId: vendorRequests.vendorId,
      department: departments.name, expectedDeliveryOn: vendorRequests.expectedDeliveryOn,
    })
      .from(vendorRequests)
      .innerJoin(departments, eq(departments.id, vendorRequests.departmentId))
      .where(and(
        eq(vendorRequests.festId, user.festId),
        isNull(vendorRequests.deletedAt),
        canFestWide(user, "vendorRequest.view")
          ? undefined
          : eq(vendorRequests.departmentId, user.departmentId),
      ))
      .orderBy(desc(vendorRequests.createdAt))
      .limit(50),
  ]);

  const byVendor = new Map(exposure.map((e) => [e.vendorId, e]));
  const canManage = can(user, "vendor.manage", { festId: user.festId, departmentId: user.departmentId });
  const totalOutstanding = exposure.reduce((s, e) => s + e.outstandingPaise, 0);

  return (
    <>
      <PageTitle
        action={
          canManage && (
            <div className="flex gap-2">
              <Link href="/vendors/new" className="rounded-full px-4 py-2 text-sm"
                style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}>
                Add vendor
              </Link>
              <Link href="/vendors/requests/new" className="rounded-full px-4 py-2 text-sm font-medium"
                style={{ background: "var(--yg-yellow)", color: "var(--yg-on-accent)" }}>
                New payment request
              </Link>
            </div>
          )
        }
      >
        Vendors
      </PageTitle>

      {totalOutstanding > 0 && (
        <p className="mb-4 text-sm text-text-soft">
          <Amount paise={totalOutstanding} className="text-text" /> contracted and not yet paid across all vendors.
        </p>
      )}

      {rows.length === 0 ? (
        <Empty icon={<Truck size={24} aria-hidden />} title="No vendors yet">
          A vendor is anyone the fest pays directly rather than reimbursing — a sound company,
          a printer, a caterer. Add one before raising a payment request against them.
        </Empty>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted">
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Contact</th>
                <th className="px-4 py-3 text-right font-medium">Contracted</th>
                <th className="px-4 py-3 text-right font-medium">Paid</th>
                <th className="px-4 py-3 text-right font-medium">Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const e = byVendor.get(v.id);
                const safe = redactVendor(user, v);
                return (
                  <tr key={v.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                    <td className="px-4 py-3">
                      <Link href={`/vendors/${v.id}`} style={{ color: "var(--yg-pink)" }}>{safe.name}</Link>
                      {safe.gstin && <p className="tnum text-xs text-text-muted">{safe.gstin}</p>}
                    </td>
                    <td className="px-4 py-3 text-text-soft">
                      {safe.contactName ?? "—"}
                      {safe.phone && <p className="tnum text-xs text-text-muted">{safe.phone}</p>}
                    </td>
                    <td className="px-4 py-3 text-right"><Amount paise={e?.contractedPaise ?? 0} /></td>
                    <td className="px-4 py-3 text-right"><Amount paise={e?.paidPaise ?? 0} /></td>
                    <td className="px-4 py-3 text-right">
                      <Amount
                        paise={e?.outstandingPaise ?? 0}
                        className={e && e.outstandingPaise > 0 ? "text-yellow" : "text-text-muted"}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      <h2 className="font-display mt-8 mb-3 text-lg">Payment requests</h2>
      {open.length === 0 ? (
        <Empty>Nothing has been contracted with a vendor yet.</Empty>
      ) : (
        <div className="space-y-2">
          {open.map((r) => (
            <Link key={r.id} href={`/vendors/requests/${r.id}`} className="block">
              <Card className="hover:border-lime">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="tnum text-xs text-text-muted">{r.humanId}</span>
                      <StateChip state={r.status} />
                    </div>
                    <p className="mt-1.5 text-sm">{r.description}</p>
                    <p className="mt-1 text-xs text-text-muted">
                      {byVendor.get(r.vendorId)?.name ?? "—"} · {r.department}
                      {r.expectedDeliveryOn ? ` · due ${r.expectedDeliveryOn}` : ""}
                    </p>
                  </div>
                  <Amount paise={r.approvedValuePaise ?? r.totalValuePaise} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
