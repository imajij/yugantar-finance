import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { Download, Printer } from "lucide-react";
import { db } from "@/db";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { festTotals } from "@/lib/queries/budget";
import { Card, PageTitle, StatCard } from "@/components/ui";

/** PRD 12.1–12.7. `formats` is what each one is actually worth having as. */
const PACK: { kind: string; label: string; hint: string; formats: ("csv" | "xlsx" | "print")[] }[] = [
  { kind: "fest-summary", label: "Fest summary", hint: "12.6 — the closing report handed to the college: budget, income, spend, cash position", formats: ["print", "xlsx"] },
  { kind: "transactions", label: "Transactions ledger", hint: "12.1 — every reimbursement and vendor milestone, with who endorsed, approved and paid it", formats: ["csv", "xlsx"] },
  { kind: "payment-batch", label: "Payment batch", hint: "12.3 — everything approved and unpaid, with payee and UPI or bank details", formats: ["csv", "xlsx"] },
  { kind: "vendor-ledger", label: "Vendor ledger", hint: "12.4 — per vendor: contracted, paid, outstanding, refunds", formats: ["xlsx", "csv"] },
  { kind: "income-ledger", label: "Income ledger", hint: "12.5 — pledged against received, in-kind marked separately", formats: ["xlsx", "csv"] },
  { kind: "audit", label: "Audit log", hint: "12.7 — every state change, append-only", formats: ["csv", "xlsx"] },
];

const FORMAT_LABEL = { csv: "CSV", xlsx: "Excel", print: "Print" } as const;

/** PRD 12 / M6 — one page that produces the reconciliation pack. */
export default async function CloseOutPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "export.run", { festId: user.festId })) nf();

  const [totals, departments, [loose]] = await Promise.all([
    festTotals(user.festId),
    db.execute<{ id: string; name: string }>(sql`
      select id, name from departments
       where fest_id = ${user.festId} and is_active and kind = 'BUDGET'
       order by name
    `) as unknown as { id: string; name: string }[],
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
              <div className="flex shrink-0 items-center gap-1.5">
                {p.formats.map((format, i) => (
                  <a
                    key={format}
                    href={`/api/v1/exports/${p.kind}?format=${format === "print" ? "html" : format}`}
                    {...(format === "print" ? { target: "_blank", rel: "noreferrer" } : {})}
                    className="flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium"
                    style={i === 0
                      ? { background: "var(--yg-lime)", color: "var(--yg-on-accent)" }
                      : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                  >
                    {format === "print" ? <Printer size={13} aria-hidden /> : <Download size={13} aria-hidden />}
                    {FORMAT_LABEL[format]}
                  </a>
                ))}
              </div>
            </div>
          </Card>
        ))}
      </div>

      <h2 className="font-display mt-8 mb-3 text-lg">Department statements</h2>
      <p className="mb-3 text-xs text-text-muted">
        PRD 12.2 — one per department: its five numbers, the line items behind them, the supporting
        documents, and every transaction. Print gives the page an HOD can sign.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {departments.map((d) => (
          <Card key={d.id}>
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-text">{d.name}</p>
              <div className="flex shrink-0 items-center gap-1.5">
                <a
                  href={`/api/v1/exports/department-statement?id=${d.id}&format=html`}
                  target="_blank" rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
                  style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                >
                  <Printer size={12} aria-hidden /> Print
                </a>
                <a
                  href={`/api/v1/exports/department-statement?id=${d.id}&format=xlsx`}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1 text-xs"
                  style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                >
                  <Download size={12} aria-hidden /> Excel
                </a>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <p className="mt-6 text-xs text-text-muted">
        Excel exports carry amounts as numbers with an Indian-grouped rupee format, so nothing has to be
        retyped. CSV carries plain decimals. Every download is itself recorded in the audit log.
      </p>
    </>
  );
}
