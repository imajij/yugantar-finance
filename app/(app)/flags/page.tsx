import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listFlags, openFlagCounts } from "@/lib/services/flags";
import { Card, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { ResolveFlag } from "./resolve";

export const dynamic = "force-dynamic";

/** Where each flagged record lives, so a row can be clicked through. */
const HREF: Record<string, (id: string) => string> = {
  REIMBURSEMENT: (id) => `/requests/${id}`,
  VENDOR_REQUEST: (id) => `/vendors/requests/${id}`,
  LINE_ITEM: () => `/budget/review`,
};

const STATUSES = ["OPEN", "ACKNOWLEDGED", "DISMISSED"] as const;

/**
 * PRD 9 (Finance HOD, "Flags panel") and 8.3.
 *
 * Flags never block anything — the whole design rests on somebody looking at them,
 * so this screen exists to make looking cheap. Worst and oldest first, the plain-
 * language explanation right there in the row, and resolving takes one note.
 */
export default async function FlagsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; entity_type?: string; severity?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "flag.view", { festId: user.festId, departmentId: user.departmentId })) nf();

  const f = await searchParams;
  const status = STATUSES.find((s) => s === f.status) ?? "OPEN";
  const entityType = ["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM"].includes(f.entity_type ?? "")
    ? (f.entity_type as "REIMBURSEMENT")
    : undefined;
  const severity = ["HIGH", "MEDIUM", "LOW"].includes(f.severity ?? "")
    ? (f.severity as "HIGH")
    : undefined;

  const [flags, counts] = await Promise.all([
    listFlags(user, { status, entityType, severity }),
    openFlagCounts(user),
  ]);

  const canResolve = can(user, "flag.resolve", { festId: user.festId });
  const query = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, entity_type: entityType, severity, ...patch })) {
      if (v) next.set(k, v);
    }
    return `/flags?${next}`;
  };

  return (
    <>
      <PageTitle>Flags</PageTitle>

      <div className="grid gap-3 sm:grid-cols-3">
        {(["HIGH", "MEDIUM", "LOW"] as const).map((s) => (
          <Card key={s}>
            <div className="flex items-center justify-between">
              <FlagChip severity={s}>{s.toLowerCase()}</FlagChip>
              <span className="tnum text-2xl">
                {s === "HIGH" ? counts.high : s === "MEDIUM" ? counts.medium : counts.low}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap gap-1.5 text-xs">
        {STATUSES.map((s) => (
          <Link
            key={s}
            href={query({ status: s })}
            className="rounded-full px-3 py-1.5"
            style={s === status
              ? { background: "var(--yg-lime)", color: "var(--yg-on-accent)" }
              : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {s.toLowerCase()}
          </Link>
        ))}
        <span className="mx-1 self-center text-text-muted">·</span>
        {(["HIGH", "MEDIUM", "LOW"] as const).map((s) => (
          <Link
            key={s}
            href={query({ severity: severity === s ? undefined : s })}
            className="rounded-full px-3 py-1.5"
            style={severity === s
              ? { background: "var(--yg-pink)", color: "var(--yg-on-accent)" }
              : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {s.toLowerCase()}
          </Link>
        ))}
      </div>

      {flags.length === 0 ? (
        <div className="mt-4">
          <Empty>
            {status === "OPEN"
              ? "Nothing is flagged. Rules re-run on every write, so this stays current on its own."
              : `No ${status.toLowerCase()} flags.`}
          </Empty>
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {flags.map((flag) => {
            const row = flag as Record<string, string>;
            const href = HREF[row.entity_type]?.(row.entity_id);
            return (
              <Card key={row.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <FlagChip severity={row.severity as "HIGH"}>
                        {row.severity.toLowerCase()} · {row.rule}
                      </FlagChip>
                      {href ? (
                        <Link href={href} className="text-sm" style={{ color: "var(--yg-pink)" }}>
                          {row.human_id}
                        </Link>
                      ) : (
                        <span className="text-sm">{row.human_id}</span>
                      )}
                      <span className="text-xs text-text-muted">{row.department_name}</span>
                      {row.entity_status && <StateChip state={row.entity_status} />}
                    </div>

                    {/* 8.3 — plain language, with the numbers in it. */}
                    <p className="mt-1.5 text-sm text-text-soft">{row.explanation}</p>

                    {row.resolution_note && (
                      <p className="mt-1.5 text-xs text-text-muted">
                        {row.status === "DISMISSED" ? "Dismissed" : "Acknowledged"}
                        {row.resolved_by_name ? ` by ${row.resolved_by_name}` : ""}: {row.resolution_note}
                      </p>
                    )}
                  </div>

                  {canResolve && row.status === "OPEN" && <ResolveFlag id={row.id} />}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-text-muted">
        Flags never block a decision (PRD 8.3). Approving a request over an open high flag is allowed
        and asks for a note — that note is what the audit log keeps. Amounts shown are in{" "}
        {formatPaise(100).replace("1.00", "rupees")}.
      </p>
    </>
  );
}
