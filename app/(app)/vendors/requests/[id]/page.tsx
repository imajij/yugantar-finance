import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { getSession } from "@/lib/session";
import { getVendorRequestDetail } from "@/lib/services/vendors";
import { can, satisfiesActorConstraints } from "@/lib/authz";
import { VENDOR_TRANSITIONS } from "@/lib/state-machines/vendor";
import { signedDownloadUrl } from "@/lib/storage";
import { Amount, Card, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { RaiseConcern } from "@/components/raise-flag";
import { TransitionActions } from "@/components/transitions";
import { Timeline } from "@/components/timeline";
import { CommentThread } from "@/components/comments";

/** PRD 9.4 / 20.7 — the milestone ladder is the story: contracted, advanced, delivered, closed. */
export default async function VendorRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const r = await getVendorRequestDetail(user, id).catch(() => null);
  if (!r) nf();

  const resource = {
    festId: user.festId, departmentId: r.departmentId,
    targetDepartmentId: r.departmentId, submitterId: r.requestedBy, status: r.status,
  };

  const actions = VENDOR_TRANSITIONS
    .filter((t) => t.from === r.status)
    .filter((t) => t.roles.includes(user.role))
    .filter((t) => satisfiesActorConstraints(t.actor, user, resource))
    .filter((t) => {
      if (["APPROVE", "RELEASE_BALANCE", "CLOSE", "CANCEL"].includes(t.action)) {
        return can(user, "vendorRequest.approve", resource);
      }
      if (t.action === "CONFIRM_DELIVERY") return can(user, "vendorRequest.confirmDelivery", resource);
      if (["RECORD_ADVANCE", "RECORD_BALANCE", "RECORD_REFUND"].includes(t.action)) {
        return can(user, "vendorRequest.recordPayment", resource);
      }
      return true;
    })
    .map((t) => ({ action: t.action, requires: [...(t.requires ?? [])] }));

  const openFlags = r.flags.filter((f) => f.status === "OPEN");
  const unpaid = r.milestones.filter((m) => m.paidPaise === null);
  const paidTotal = r.milestones.reduce((s, m) => s + (m.paidPaise ?? 0), 0);
  const contracted = r.approvedValuePaise ?? r.totalValuePaise;

  const files = await Promise.all(
    r.attachments.filter((a) => a.storageKey).map(async (a) => ({
      id: a.id, name: a.fileName ?? "file", purpose: a.purpose,
      url: await signedDownloadUrl(a.storageKey!),
    })),
  );

  return (
    <div className="max-w-3xl">
      <PageTitle
        action={
          <div className="flex flex-wrap items-center gap-2">
            <RaiseConcern
              entityType="VENDOR_REQUEST"
              entityId={r.id}
              allowed={can(user, "flag.raise", { festId: user.festId, departmentId: user.departmentId })}
            />
            <StateChip state={r.status} />
          </div>
        }
      >
        <span className="tnum">{r.humanId}</span>
      </PageTitle>

      <Card>
        <p className="text-lg">{r.description}</p>
        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Row label="Vendor">
            <Link href={`/vendors/${r.vendorId}`} style={{ color: "var(--yg-pink)" }}>{r.vendor.name}</Link>
          </Row>
          <Row label="Line item">{r.lineItem?.name}</Row>
          <Row label="Requested">
            <Amount paise={r.totalValuePaise} />
            {r.approvedValuePaise !== null && r.approvedValuePaise !== r.totalValuePaise && (
              <span className="ml-2 text-xs text-text-muted">approved <Amount paise={r.approvedValuePaise} /></span>
            )}
          </Row>
          <Row label="Paid so far"><Amount paise={paidTotal} /></Row>
          <Row label="Raised by">{r.requester?.name}</Row>
          {r.expectedDeliveryOn && <Row label="Expected"><span className="tnum">{r.expectedDeliveryOn}</span></Row>}
          {r.deliveredAt && (
            <Row label="Delivered"><span className="tnum">{new Date(r.deliveredAt).toLocaleDateString("en-IN")}</span></Row>
          )}
          {r.refundExpectedPaise > 0 && (
            <Row label="Refund">
              <Amount paise={r.refundReceivedPaise} /> of <Amount paise={r.refundExpectedPaise} /> back
            </Row>
          )}
          {r.balanceAdjustReason && <Row label="Balance reduced because">{r.balanceAdjustReason}</Row>}
          {r.deliveryNote && <Row label="Delivery note">{r.deliveryNote}</Row>}
        </dl>
      </Card>

      <Card className="mt-4">
        <h2 className="font-display text-sm">Milestones</h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-text-muted">
              <th className="pb-2 font-medium">Stage</th>
              <th className="pb-2 text-right font-medium">Planned</th>
              <th className="pb-2 text-right font-medium">Paid</th>
              <th className="pb-2 text-right font-medium">Reference</th>
            </tr>
          </thead>
          <tbody>
            {r.milestones.map((m) => (
              <tr key={m.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                <td className="py-2">{m.kind.toLowerCase()}</td>
                <td className="py-2 text-right"><Amount paise={m.plannedPaise} /></td>
                <td className="py-2 text-right">
                  {m.paidPaise === null
                    ? <span className="text-xs text-text-muted">unpaid</span>
                    : <Amount paise={m.paidPaise} className="text-lime" />}
                </td>
                <td className="tnum py-2 text-right text-xs text-text-muted">{m.paymentReference ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-text-muted">
          The whole approved value <Amount paise={contracted} /> is committed against the line item;
          each payment moves that slice from committed to spent.
        </p>
      </Card>

      {openFlags.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display flex items-center gap-2 text-sm">
            <AlertTriangle size={15} aria-hidden style={{ color: "var(--flag-high-fg)" }} />
            {openFlags.length} open flag{openFlags.length === 1 ? "" : "s"}
          </h2>
          <ul className="mt-3 space-y-2">
            {openFlags.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start gap-2 text-sm">
                <FlagChip severity={f.severity}>{f.rule}</FlagChip>
                <span className="text-text-soft">{f.explanation}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {files.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Documents</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {files.map((f) => (
              <li key={f.id}>
                <a href={f.url} target="_blank" rel="noreferrer" style={{ color: "var(--yg-pink)" }}>{f.name}</a>
                <span className="ml-2 text-xs text-text-muted">{f.purpose?.toLowerCase()}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-muted">Links expire in 15 minutes.</p>
        </Card>
      )}

      {actions.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Actions</h2>
          <TransitionActions
            endpoint={`/api/v1/vendor-requests/${r.id}/transitions`}
            actions={actions}
            options={{
              milestone_id: unpaid.map((m) => ({
                value: m.id,
                label: `${m.kind.toLowerCase()} — planned ₹${(m.plannedPaise / 100).toLocaleString("en-IN")}`,
              })),
            }}
          />
        </Card>
      )}

      <Timeline events={r.timeline} />

      <CommentThread entityType="VENDOR_REQUEST" entityId={r.id} comments={r.comments} />

      {r.milestones.length === 0 && <Empty>This request has no milestones, which should not happen.</Empty>}
    </div>
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
