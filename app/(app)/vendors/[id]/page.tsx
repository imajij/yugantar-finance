import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, vendorRequests, vendors } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { redactVendor, vendorExposure } from "@/lib/services/vendors";
import { Amount, Card, Empty, PageTitle, StateChip } from "@/components/ui";
import { VendorAdmin } from "./edit";

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "vendor.view", { festId: user.festId })) nf();

  const [row] = await db.select().from(vendors)
    .where(and(eq(vendors.id, id), eq(vendors.festId, user.festId), isNull(vendors.deletedAt))).limit(1);
  if (!row) nf();

  const vendor = redactVendor(user, row);
  const [[exposure], requests] = await Promise.all([
    vendorExposure(user.festId, id),
    db.select({
      id: vendorRequests.id, humanId: vendorRequests.humanId, status: vendorRequests.status,
      description: vendorRequests.description, totalValuePaise: vendorRequests.totalValuePaise,
      approvedValuePaise: vendorRequests.approvedValuePaise, department: departments.name,
      expectedDeliveryOn: vendorRequests.expectedDeliveryOn, deliveredAt: vendorRequests.deliveredAt,
    })
      .from(vendorRequests)
      .innerJoin(departments, eq(departments.id, vendorRequests.departmentId))
      .where(and(eq(vendorRequests.vendorId, id), isNull(vendorRequests.deletedAt)))
      .orderBy(desc(vendorRequests.createdAt)),
  ]);

  const seesBank = can(user, "vendor.bankDetails.view", { festId: user.festId });

  return (
    <div className="max-w-3xl">
      <PageTitle>{vendor.name}</PageTitle>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Contracted" paise={exposure?.contractedPaise ?? 0} />
        <Stat label="Paid" paise={exposure?.paidPaise ?? 0} />
        <Stat label="Outstanding" paise={exposure?.outstandingPaise ?? 0} tone />
      </div>

      <Card className="mt-4">
        <h2 className="font-display text-sm">Details</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Row label="Contact">{vendor.contactName ?? "—"}</Row>
          <Row label="Phone"><span className="tnum">{vendor.phone ?? "—"}</span></Row>
          <Row label="Email">{vendor.email ?? "—"}</Row>
          <Row label="GSTIN"><span className="tnum">{vendor.gstin ?? "—"}</span></Row>
          <Row label="UPI"><span className="tnum">{vendor.upiId ?? "—"}</span></Row>
          <Row label="Account name">{vendor.bankAccountName ?? "—"}</Row>
          <Row label="Account number"><span className="tnum">{vendor.bankAccountNumber ?? "—"}</span></Row>
          <Row label="IFSC"><span className="tnum">{vendor.bankIfsc ?? "—"}</span></Row>
        </dl>
        {!seesBank && (
          <p className="mt-3 text-xs text-text-muted">
            Bank details are masked. Finance and Management see them in full (20.7).
          </p>
        )}
        {vendor.notes && <p className="mt-3 text-sm text-text-soft">{vendor.notes}</p>}

        <VendorAdmin
          vendor={{
            id: vendor.id,
            name: vendor.name,
            contactName: vendor.contactName,
            phone: vendor.phone,
            email: vendor.email,
            gstin: vendor.gstin,
            upiId: vendor.upiId,
            bankAccountName: vendor.bankAccountName,
            bankAccountNumber: vendor.bankAccountNumber,
            bankIfsc: vendor.bankIfsc,
            notes: vendor.notes,
          }}
          canEdit={can(user, "vendor.manage", { festId: user.festId, departmentId: user.departmentId })}
          canEditBank={seesBank}
          canDelete={can(user, "vendor.delete", { festId: user.festId })}
        />
      </Card>

      <h2 className="font-display mt-8 mb-3 text-lg">Payment requests</h2>
      {requests.length === 0 ? (
        <Empty>Nothing has been contracted with this vendor yet.</Empty>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => (
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
                      {r.department}
                      {r.expectedDeliveryOn ? ` · expected ${r.expectedDeliveryOn}` : ""}
                      {r.deliveredAt ? " · delivered" : ""}
                    </p>
                  </div>
                  <Amount paise={r.approvedValuePaise ?? r.totalValuePaise} />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, paise, tone }: { label: string; paise: number; tone?: boolean }) {
  return (
    <Card>
      <p className="font-display text-xs tracking-wide text-text-muted uppercase">{label}</p>
      <p className="tnum mt-2 text-xl" style={{ color: tone && paise > 0 ? "var(--yg-yellow)" : "var(--yg-text)" }}>
        <Amount paise={paise} />
      </p>
    </Card>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
