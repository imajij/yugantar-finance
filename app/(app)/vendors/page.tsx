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
        <div className="flex flex-col gap-2.5">
          {rows.map((v) => {
            const e = byVendor.get(v.id);
            const safe = redactVendor(user, v);
            return (
              <Link
                key={v.id}
                href={`/vendors/${v.id}`}
                className="flex flex-col gap-3 rounded-[var(--r-card)] p-4 hover:border-lime sm:flex-row sm:items-center sm:gap-4"
                style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[14px]">{safe.name}</span>
                  <span className="text-[12px] text-text-muted">
                    {safe.contactName ?? "no contact"}
                    {safe.phone && <span className="tnum"> · {safe.phone}</span>}
                    {safe.gstin && <span className="tnum"> · {safe.gstin}</span>}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-4 sm:w-[300px] sm:shrink-0">
                  <Figure label="Contracted" paise={e?.contractedPaise ?? 0} />
                  <Figure label="Paid" paise={e?.paidPaise ?? 0} />
                  <Figure
                    label="Outstanding"
                    paise={e?.outstandingPaise ?? 0}
                    tone={e && e.outstandingPaise > 0 ? "var(--yg-yellow)" : undefined}
                  />
                </div>
              </Link>
            );
          })}
        </div>
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

/** A labelled amount — the label is what a table head used to carry. */
function Figure({ label, paise, tone }: { label: string; paise: number; tone?: string }) {
  return (
    <span className="flex flex-col gap-0.5 sm:text-right">
      <span className="text-[11px] text-text-muted">{label}</span>
      <span className="tnum text-[13.5px]" style={{ color: tone }}>
        <Amount paise={paise} />
      </span>
    </span>
  );
}
