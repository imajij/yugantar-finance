import { notFound as nf, redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { getSession } from "@/lib/session";
import { getReimbursementDetail } from "@/lib/services/reimbursements";
import { can, satisfiesActorConstraints } from "@/lib/authz";
import { REIMBURSEMENT_TRANSITIONS } from "@/lib/state-machines/reimbursement";
import { signedDownloadUrl } from "@/lib/storage";
import { Amount, Card, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { TransitionActions } from "./actions";

export default async function RequestDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const req = await getReimbursementDetail(user, id).catch(() => null);
  if (!req) nf();

  const resource = {
    festId: user.festId, departmentId: req.departmentId,
    targetDepartmentId: req.departmentId, submitterId: req.submitterId,
    submitterRole: req.submitter.role, status: req.status,
  };

  /** The same table the API validates against, filtered by role and actor constraints. */
  const actions = REIMBURSEMENT_TRANSITIONS
    .filter((t) => t.from === req.status)
    .filter((t) => t.roles.includes(user.role))
    .filter((t) => satisfiesActorConstraints(t.actor, user, resource))
    .filter((t) => {
      if (t.action === "ENDORSE") return can(user, "reimbursement.endorse", resource);
      if (t.action === "APPROVE") return can(user, "reimbursement.approve", resource);
      if (t.action === "RECORD_PAYMENT") return can(user, "reimbursement.recordPayment", resource);
      if (t.action === "HOLD") return can(user, "reimbursement.hold", resource);
      return true;
    })
    .map((t) => ({ action: t.action, requires: [...(t.requires ?? [])] }));

  const openFlags = req.flags.filter((f) => f.status === "OPEN");
  const receipts = await Promise.all(
    req.attachments.filter((a) => a.storageKey).map(async (a) => ({
      id: a.id, name: a.fileName ?? "receipt", url: await signedDownloadUrl(a.storageKey!),
    })),
  );

  return (
    <div className="max-w-3xl">
      <PageTitle action={<StateChip state={req.status} />}>
        <span className="tnum">{req.humanId}</span>
      </PageTitle>

      <Card>
        <p className="text-lg">{req.description}</p>
        <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Row label="Amount"><Amount paise={req.amountPaise} /></Row>
          <Row label="Transaction date"><span className="tnum">{req.transactionOn}</span></Row>
          <Row label="Submitted by">{req.submitter.name}</Row>
          <Row label="Waiting on">{req.waiting_on}</Row>
          <Row label="Pay to">{req.payeeName}</Row>
          <Row label="Payee UPI"><span className="tnum">{req.payeeUpiId}</span></Row>
          {req.merchant && <Row label="Merchant">{req.merchant}</Row>}
          {req.paymentReference && <Row label="Payment reference"><span className="tnum">{req.paymentReference}</span></Row>}
          {req.lastReason && <Row label="Latest reason">{req.lastReason}</Row>}
        </dl>
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
          <p className="mt-3 text-xs text-text-muted">
            Flags are advisory. Approving over an open High flag needs an acknowledgement note.
          </p>
        </Card>
      )}

      {receipts.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Receipts</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {receipts.map((r) => (
              <li key={r.id}>
                <a href={r.url} target="_blank" rel="noreferrer" style={{ color: "var(--yg-pink)" }}>{r.name}</a>
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
            requestId={req.id}
            actions={actions}
            hasOpenHighFlag={openFlags.some((f) => f.severity === "HIGH")}
          />
        </Card>
      )}

      <Card className="mt-4">
        <h2 className="font-display text-sm">Timeline</h2>
        <ol className="mt-3 space-y-3">
          {req.timeline.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="text-text">{humanAction(e.action)}</span>
              <span className="text-text-muted"> · {e.actor ?? "System"} · </span>
              <span className="tnum text-xs text-text-muted">{new Date(e.createdAt).toLocaleString("en-IN")}</span>
              {e.reason && <p className="mt-0.5 text-xs text-text-soft">&ldquo;{e.reason}&rdquo;</p>}
            </li>
          ))}
        </ol>
      </Card>
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

const ACTION_LABELS: Record<string, string> = {
  SUBMIT: "Submitted", RESUBMIT: "Resubmitted", ENDORSE: "Endorsed by the department HOD",
  SEND_BACK: "Sent back for changes", DECLINE: "Declined", APPROVE: "Approved by Finance",
  HOLD: "Payment put on hold", RESOLVE_HOLD: "Hold resolved", RECORD_PAYMENT: "Payment recorded",
  WITHDRAW: "Withdrawn by the submitter",
};

function humanAction(action: string): string {
  if (action === "reimbursement.create") return "Created as a draft";
  if (action === "reimbursement.update") return "Edited";
  const key = action.replace("reimbursement.transition.", "").replace("reimbursement.", "").toUpperCase();
  return ACTION_LABELS[key] ?? action;
}
