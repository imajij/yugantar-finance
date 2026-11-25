import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { getSession } from "@/lib/session";
import { getVendorRequestDetail, owedOn } from "@/lib/services/vendors";
import { can, satisfiesActorConstraints } from "@/lib/authz";
import { VENDOR_TRANSITIONS } from "@/lib/state-machines/vendor";
import { Amount, Card, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { RaiseConcern } from "@/components/raise-flag";
import { TransitionActions } from "@/components/transitions";
import { Timeline } from "@/components/timeline";
import { CommentThread } from "@/components/comments";
import { AddDocuments } from "@/components/add-documents";
import { RecordVendorPayment, type Payable } from "./record-payment";

const PAYMENT_ACTIONS = ["RECORD_ADVANCE", "RECORD_BALANCE", "RECORD_REMAINING"];

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
      if ([...PAYMENT_ACTIONS, "RECORD_REFUND"].includes(t.action)) {
        return can(user, "vendorRequest.recordPayment", resource);
      }
      return true;
    })
    .map((t) => ({ action: t.action, requires: [...(t.requires ?? [])] }));

  /*
   * Payments get their own form rather than the generic one: it asks whether the
   * milestone was paid in full or in part, and takes the receipt. Which milestone
   * each action can pay follows the service's rule — the first payment names the
   * advance or the balance, and anything paid in part is finished by the remaining
   * payment.
   */
  const allowed = new Set(actions.map((a) => a.action));
  const payables: Payable[] = r.milestones.flatMap((m) => {
    const owed = owedOn(m);
    const paid = m.paidPaise ?? 0;
    if (owed === 0) return [];
    const action = paid > 0 ? "RECORD_REMAINING" : m.kind === "ADVANCE" ? "RECORD_ADVANCE" : "RECORD_BALANCE";
    if (!allowed.has(action)) return [];
    return [{ milestoneId: m.id, kind: m.kind, action, plannedPaise: m.plannedPaise, paidPaise: paid, owedPaise: owed }];
  });
  const otherActions = actions.filter((a) => !PAYMENT_ACTIONS.includes(a.action));

  const openFlags = r.flags.filter((f) => f.status === "OPEN");
  const paidTotal = r.milestones.reduce((s, m) => s + (m.paidPaise ?? 0), 0);
  const contracted = r.approvedValuePaise ?? r.totalValuePaise;

  // Linked through the API rather than to a signed URL minted here — the signature
  // is short-lived and would go stale on a page somebody left open.
  // Adding is allowed after submission; taking a file off is not (attachments.ts).
  const canAddDocuments = can(user, "vendorRequest.document.add", resource);

  const files = r.attachments
    .filter((a) => a.storageKey)
    .map((a) => ({ id: a.id, name: a.fileName ?? "file", purpose: a.purpose }));

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
            <Link href={`/vendors/${r.vendorId}`} style={{ color: "var(--yg-accent)" }}>{r.vendor.name}</Link>
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
              <th className="pb-2 text-right font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {r.milestones.map((m) => (
              <tr key={m.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
                <td className="py-2">{m.kind.toLowerCase()}</td>
                <td className="py-2 text-right"><Amount paise={m.plannedPaise} /></td>
                <td className="py-2 text-right">
                  {m.paidPaise === null
                    ? <span className="text-xs text-text-muted">—</span>
                    : <Amount paise={m.paidPaise} className="text-accent" />}
                </td>
                <td className="py-2 text-right text-xs">
                  {m.paidAt
                    ? <span style={{ color: "var(--state-done-fg)" }}>paid in full</span>
                    : (m.paidPaise ?? 0) > 0
                      ? <span style={{ color: "var(--state-waiting-fg)" }}>part paid · <Amount paise={owedOn(m)} /> left</span>
                      : owedOn(m) === 0
                        ? <span className="text-text-muted">nothing due</span>
                        : <span className="text-text-muted">unpaid</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-text-muted">
          The whole approved value <Amount paise={contracted} /> is committed against the line item;
          each payment moves that slice from committed to spent.
        </p>
      </Card>

      {r.payments.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Payments</h2>
          <ul className="mt-3 flex flex-col">
            {r.payments.map((p) => {
              const stage = r.milestones.find((m) => m.id === p.milestoneId)?.kind.toLowerCase() ?? "payment";
              return (
                <li
                  key={p.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2.5 text-sm"
                  style={{ borderTop: "1px solid var(--yg-surface-2)" }}
                >
                  <span className="flex flex-col gap-0.5">
                    <span>
                      <Amount paise={p.amountPaise} /> <span className="text-text-muted">· {stage}</span>
                    </span>
                    <span className="text-xs text-text-muted">
                      <span className="tnum">{new Date(p.paidAt).toLocaleDateString("en-IN")}</span>
                      {" · "}<span className="tnum">{p.paymentReference}</span>
                      {p.paidBy && <> · {p.paidBy}</>}
                    </span>
                  </span>
                  {p.proofAttachmentId ? (
                    <a
                      href={`/api/v1/attachments/${p.proofAttachmentId}/url?redirect=1`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs"
                      style={{ color: "var(--yg-accent)" }}
                    >
                      Receipt
                    </a>
                  ) : (
                    <span className="text-xs text-text-muted">no receipt</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

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

      {(files.length > 0 || canAddDocuments) && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Documents</h2>
          {files.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">No quote or invoice is attached yet.</p>
          )}
          <ul className="mt-2 space-y-1 text-sm">
            {files.map((f) => (
              <li key={f.id}>
                <a
                  href={`/api/v1/attachments/${f.id}/url?redirect=1`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--yg-accent)" }}
                >
                  {f.name}
                </a>
                <span className="ml-2 text-xs text-text-muted">{DOCUMENT_KIND[f.purpose ?? ""] ?? f.purpose?.toLowerCase()}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-text-muted">
            Documents are kept for the life of the fest. Each open is checked and logged.
          </p>
          {canAddDocuments && (
            <AddDocuments
              endpoint={`/api/v1/vendor-requests/${r.id}/documents`}
              kinds={[
                { value: "INVOICE", label: "Invoice" },
                { value: "QUOTE", label: "Quote" },
                { value: "PO", label: "Purchase order" },
                { value: "DELIVERY_PROOF", label: "Delivery proof" },
                { value: "OTHER", label: "Something else" },
              ]}
              max={10 - files.length}
              hint="A revised invoice, a purchase order, a delivery note. Added files stay on the request and show on its timeline. JPG, PNG, HEIC or PDF, up to 10 MB each."
            />
          )}
        </Card>
      )}

      {(payables.length > 0 || otherActions.length > 0) && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Actions</h2>
          {payables.length > 0 && (
            <RecordVendorPayment requestId={r.id} vendorName={r.vendor.name} payables={payables} />
          )}
          <TransitionActions
            endpoint={`/api/v1/vendor-requests/${r.id}/transitions`}
            actions={otherActions}
            // Approving a request you raised is allowed for Finance, with a note (5.2).
            extraFields={r.requestedBy === user.id ? { APPROVE: ["note"] } : {}}
            consequences={r.requestedBy === user.id ? {
              APPROVE: "You raised this request, so you are approving your own. Say why — the note goes on "
                + "the record, the whole value is committed against the line item, and Management is told.",
            } : {}}
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

const DOCUMENT_KIND: Record<string, string> = {
  QUOTE: "quote", INVOICE: "invoice", PO: "purchase order", DELIVERY_PROOF: "delivery proof",
  PAYMENT_PROOF: "payment receipt", OTHER: "document",
};
