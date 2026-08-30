import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { Flag } from "lucide-react";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { listFlags, openFlagCounts } from "@/lib/services/flags";
import { Card, Empty, FlagChip, PageTitle, StateChip } from "@/components/ui";
import { formatPaise } from "@/lib/money";
import { ResolveFlag } from "./resolve";
import { RaiseFlagLink } from "./raise-link";

export const dynamic = "force-dynamic";

/** Where each flagged thing lives, so a row can be clicked through. */
const HREF: Record<string, (id: string) => string> = {
  REIMBURSEMENT: (id) => `/requests/${id}`,
  VENDOR_REQUEST: (id) => `/vendors/requests/${id}`,
  LINE_ITEM: () => `/budget/review`,
  DEPARTMENT: (id) => `/budget/${id}`,
  USER: () => `/admin`,
};

const STATUSES = ["OPEN", "ACKNOWLEDGED", "DISMISSED"] as const;
const ENTITY_TYPES = ["REIMBURSEMENT", "VENDOR_REQUEST", "LINE_ITEM", "DEPARTMENT", "USER"] as const;
const SOURCES = [
  { key: "MANUAL", label: "Raised by a person" },
  { key: "RULE", label: "Raised by a rule" },
] as const;

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
  searchParams: Promise<{ status?: string; entity_type?: string; severity?: string; source?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "flag.view", { festId: user.festId, departmentId: user.departmentId })) nf();

  const f = await searchParams;
  const status = STATUSES.find((s) => s === f.status) ?? "OPEN";
  const entityType = (ENTITY_TYPES as readonly string[]).includes(f.entity_type ?? "")
    ? (f.entity_type as "REIMBURSEMENT")
    : undefined;
  const source = SOURCES.find((s) => s.key === f.source)?.key;
  const severity = ["HIGH", "MEDIUM", "LOW"].includes(f.severity ?? "")
    ? (f.severity as "HIGH")
    : undefined;

  const [flags, counts] = await Promise.all([
    listFlags(user, { status, entityType, severity, source }),
    openFlagCounts(user),
  ]);

  const canResolve = can(user, "flag.resolve", { festId: user.festId });
  const query = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, entity_type: entityType, severity, source, ...patch })) {
      if (v) next.set(k, v);
    }
    return `/flags?${next}`;
  };

  return (
    <>
      <PageTitle
        action={
          <RaiseFlagLink
            allowed={can(user, "flag.raise", { festId: user.festId, departmentId: user.departmentId })}
          />
        }
      >
        Flags
      </PageTitle>

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
              ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)" }
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
              ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)" }
              : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {s.toLowerCase()}
          </Link>
        ))}
        <span className="mx-1 self-center text-text-muted">·</span>
        {SOURCES.map((s) => (
          <Link
            key={s.key}
            href={query({ source: source === s.key ? undefined : s.key })}
            className="rounded-full px-3 py-1.5"
            style={source === s.key
              ? { background: "var(--yg-info)", color: "var(--yg-on-accent)" }
              : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {s.label}
          </Link>
        ))}
        <span className="mx-1 self-center text-text-muted">·</span>
        {ENTITY_TYPES.map((t) => (
          <Link
            key={t}
            href={query({ entity_type: entityType === t ? undefined : t })}
            className="rounded-full px-3 py-1.5"
            style={entityType === t
              ? { background: "var(--yg-accent)", color: "var(--yg-on-accent)" }
              : { background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {t.toLowerCase().replace("_", " ")}
          </Link>
        ))}
      </div>

      {flags.length === 0 ? (
        <div className="mt-4">
          <Empty
            icon={<Flag size={24} aria-hidden />}
            title={status === "OPEN" ? "Nothing is flagged" : `No ${status.toLowerCase()} flags`}
          >
            {status === "OPEN"
              ? "The rules re-run on every write, so this stays current on its own. Anyone running a department can also raise a concern by hand from the record itself."
              : "Nothing has been resolved this way yet."}
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
                        {row.severity.toLowerCase()} · {row.raised_by_name ? "raised by hand" : row.rule}
                      </FlagChip>
                      {href ? (
                        <Link href={href} className="text-sm" style={{ color: "var(--yg-accent)" }}>
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

                    {row.raised_by_name && (
                      <p className="mt-1 text-xs text-text-muted">
                        {row.raised_by_name} raised this{" "}
                        {new Date(row.created_at).toLocaleString("en-IN", {
                          day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
                        })}
                      </p>
                    )}

                    {row.resolution_note && (
                      <p className="mt-1.5 text-xs text-text-muted">
                        {row.status === "DISMISSED" ? "Dismissed" : "Acknowledged"}
                        {row.resolved_by_name ? ` by ${row.resolved_by_name}` : ""}: {row.resolution_note}
                      </p>
                    )}
                  </div>

                  {row.status === "OPEN" && (
                    <ResolveFlag
                      id={row.id}
                      canResolve={canResolve}
                      canWithdraw={row.raised_by_id === user.id}
                    />
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-text-muted">
        Anyone running a department can raise a concern by hand — on a request, a line item, a
        department, or a person — from the record itself. It lands here alongside the rules and
        resolves the same way, so a concern cannot quietly evaporate. Flags never block a
        decision (PRD 8.3). Approving a request over an open high flag is allowed
        and asks for a note — that note is what the audit log keeps. Amounts shown are in{" "}
        {formatPaise(100).replace("1.00", "rupees")}.
      </p>
    </>
  );
}
