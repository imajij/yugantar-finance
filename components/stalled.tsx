import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { formatPaise } from "@/lib/money";
import type { StalledStage } from "@/lib/queries/stalled";

/**
 * "Committed says ₹2.00 and Spent says ₹0.00, and it never changes."
 *
 * The numbers are right; the workflow has stopped. A segregated approval chain
 * (PRD 5.2) deadlocks when a seat is empty — an approved reimbursement can only be
 * paid by Management, so a fest whose Management account never accepted its
 * invitation accrues Committed forever. The person who notices is Finance, staring
 * at a figure that will not move, and the queue that would explain it belongs to
 * somebody who does not exist.
 *
 * So this says it where the figure is.
 */
export function StalledNotice({ stages, canFix }: { stages: StalledStage[]; canFix: boolean }) {
  if (stages.length === 0) return null;

  return (
    <div className="mt-4 space-y-2">
      {stages.map((s) => (
        <div
          key={s.needs}
          className="flex flex-wrap items-start gap-2 rounded-lg px-3 py-2.5 text-sm"
          style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p>
              <strong className="tnum">{formatPaise(s.amountPaise)}</strong> across{" "}
              {s.count} {s.count === 1 ? "request is" : "requests are"} {s.label}, and this fest has
              no active {s.needsLabel} account to do it.
            </p>
            <p className="mt-1 text-xs opacity-90">
              {s.invitedNotActive > 0
                ? `${s.invitedNotActive === 1 ? "One account has" : `${s.invitedNotActive} accounts have`} been invited but never signed in. Until somebody does, this money stays counted as Committed and never becomes Spent.`
                : "Nobody has been given that role yet. Until somebody is, this money stays counted as Committed and never becomes Spent."}
              {" "}Segregation of duties (PRD 5.2) is deliberate — the fix is to fill the seat, not to move the authority.
            </p>
            {canFix && (
              <Link href="/admin" className="mt-1.5 inline-block text-xs underline underline-offset-2">
                {s.invitedNotActive > 0
                  ? "Resend their invitation from Admin →"
                  : "Give somebody that role in Admin →"}
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
