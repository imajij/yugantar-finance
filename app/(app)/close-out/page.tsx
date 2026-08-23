import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { Download } from "lucide-react";
import { db } from "@/db";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { festTotals } from "@/lib/queries/budget";
import { Card, PageTitle, StatCard } from "@/components/ui";

const PACK: { kind: string; label: string; hint: string }[] = [
  { kind: "line-items", label: "Budget vs actual", hint: "The five numbers per line item — the sheet that must reconcile" },
  { kind: "reimbursements", label: "Reimbursements", hint: "Every claim with who endorsed, approved and paid it" },
  { kind: "vendor-payments", label: "Vendor payments", hint: "Contracted, paid, outstanding and refunds" },
  { kind: "income", label: "Income", hint: "Pledged against received, in-kind marked separately" },
  { kind: "tickets", label: "Work tickets", hint: "What was asked of whom, and whether it landed on time" },
  { kind: "audit", label: "Audit log", hint: "Every state change, append-only" },
];

/** PRD 12 / M6 — one page that produces the reconciliation pack. */
export default async function CloseOutPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "export.run", { festId: user.festId })) nf();

  const [totals, [loose]] = await Promise.all([
    festTotals(user.festId),
    db.execute<Record<string, string>>(sql`
      select
        (select count(*) from reimbursement_requests
          where fest_id = ${user.festId} and deleted_at is null
            and status not in ('PAID','DECLINED','WITHDRAWN'))                     as open_reimbursements,
        (select count(*) from vendor_requests
          where fest_id = ${user.festId} and deleted_at is null
            and status not in ('CLOSED','DECLINED','CANCELLED'))                   as open_vendor_requests,
        (select count(*) from tickets
          where fest_id = ${user.festId} and deleted_at is null
            and status not in ('CLOSED','REJECTED','CANCELLED'))                   as open_tickets,
        (select count(*) from income_entries
          where fest_id = ${user.festId} and deleted_at is null
            and status in ('PLEDGED','PARTIALLY_RECEIVED'))                        as unreceived_income,
        (select count(*) from flags f join reimbursement_requests r on r.id = f.entity_id
          where r.fest_id = ${user.festId} and f.status = 'OPEN')                   as open_flags,
        (select count(*) from line_items
          where fest_id = ${user.festId} and deleted_at is null and reviewed_at is null) as unreviewed_line_items
    `) as unknown as Record<string, string>[],
  ]);

  const blockers = [
    { n: Number(loose.open_reimbursements), label: "reimbursements still moving", href: "/requests" },
    { n: Number(loose.open_vendor_requests), label: "vendor requests not closed", href: "/vendors" },
    { n: Number(loose.open_tickets), label: "work tickets still open", href: "/tickets" },
    { n: Number(loose.unreceived_income), label: "pledges not fully received", href: "/income" },
    { n: Number(loose.open_flags), label: "open flags on reimbursements", href: "/queues" },
    { n: Number(loose.unreviewed_line_items), label: "line items never reviewed", href: "/budget/review" },
  ].filter((b) => b.n > 0);

  return (
    <>
      <PageTitle>Close-out</PageTitle>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Income received" paise={totals?.incomeReceivedPaise ?? 0} tone="done" />
        <StatCard label="Spent" paise={totals?.spentPaise ?? 0} />
        <StatCard label="Cash position" paise={totals?.cashPositionPaise ?? 0} tone="done" />
        <StatCard
          label="Projected close" paise={totals?.projectedClosePaise ?? 0}
          hint="If every pledge lands and every commitment is paid"
        />
      </div>

      <Card className="mt-6">
        <h2 className="font-display text-sm">Loose ends</h2>
        {blockers.length === 0 ? (
          <p className="mt-2 text-sm" style={{ color: "var(--state-done-fg)" }}>
            Nothing is still in flight. The numbers below are final.
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-text-muted">
              These do not block an export — they tell you the pack is a snapshot, not a final account.
            </p>
            <ul className="mt-3 space-y-1 text-sm">
              {blockers.map((b) => (
                <li key={b.label}>
                  <Link href={b.href} style={{ color: "var(--yg-pink)" }}>
                    <span className="tnum">{b.n}</span> {b.label}
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <h2 className="font-display mt-8 mb-3 text-lg">Reconciliation pack</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {PACK.map((p) => (
          <Card key={p.kind}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-text">{p.label}</p>
                <p className="mt-0.5 text-xs text-text-muted">{p.hint}</p>
              </div>
              <a
                href={`/api/v1/exports/${p.kind}`}
                className="flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium"
                style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
              >
                <Download size={13} aria-hidden />
                CSV
              </a>
            </div>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs text-text-muted">
        Amounts export as rupees with two decimals. Every download is itself recorded in the audit log.
      </p>
    </>
  );
}
