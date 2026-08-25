import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { Empty, PageTitle } from "@/components/ui";

const ENTITY_TYPES = [
  "REIMBURSEMENT", "VENDOR_REQUEST", "TICKET", "LINE_ITEM", "DEPARTMENT", "INCOME_ENTRY", "VENDOR", "USER", "FEST",
] as const;

/** Where each entity type lives, so a log line can be clicked through. */
const HREF: Partial<Record<string, (id: string) => string>> = {
  REIMBURSEMENT: (id) => `/requests/${id}`,
  VENDOR_REQUEST: (id) => `/vendors/requests/${id}`,
  TICKET: (id) => `/tickets/${id}`,
  VENDOR: (id) => `/vendors/${id}`,
  DEPARTMENT: (id) => `/budget/${id}`,
};

/** PRD 10 — append-only, newest first, filterable. Read-only by construction. */
export default async function AuditPage({
  searchParams,
}: { searchParams: Promise<{ entity_type?: string; actor?: string; q?: string; before?: string }> }) {
  const user = await getSession();
  if (!user) redirect("/sign-in");
  if (!can(user, "audit.view", { festId: user.festId })) nf();

  const f = await searchParams;
  const entityType = ENTITY_TYPES.find((t) => t === f.entity_type);

  const rows = await db
    .select({
      id: auditEvents.id, entityType: auditEvents.entityType, entityId: auditEvents.entityId,
      action: auditEvents.action, reason: auditEvents.reason, before: auditEvents.before,
      after: auditEvents.after, createdAt: auditEvents.createdAt, actor: users.name, actorId: auditEvents.actorId,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorId))
    .where(and(
      eq(auditEvents.festId, user.festId),
      entityType ? eq(auditEvents.entityType, entityType) : undefined,
      f.actor ? eq(auditEvents.actorId, f.actor) : undefined,
      f.q ? sql`${auditEvents.action} ilike ${"%" + f.q + "%"}` : undefined,
      f.before ? sql`${auditEvents.createdAt} < ${f.before}` : undefined,
    ))
    .orderBy(desc(auditEvents.createdAt))
    .limit(101);

  const pageRows = rows.slice(0, 100);
  const more = rows.length > 100;

  const actors = await db
    .selectDistinct({ id: users.id, name: users.name })
    .from(auditEvents).innerJoin(users, eq(users.id, auditEvents.actorId))
    .where(eq(auditEvents.festId, user.festId))
    .orderBy(users.name);

  const qs = (patch: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    const merged = { entity_type: f.entity_type, actor: f.actor, q: f.q, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    return `/audit${p.size ? `?${p}` : ""}`;
  };

  return (
    <>
      <PageTitle>Audit log</PageTitle>

      <form className="mb-4 flex flex-wrap items-end gap-2" action="/audit">
        <select name="entity_type" defaultValue={f.entity_type ?? ""} className={FILTER}>
          <option value="">All entities</option>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t.replace("_", " ").toLowerCase()}</option>)}
        </select>
        <select name="actor" defaultValue={f.actor ?? ""} className={FILTER}>
          <option value="">Anyone</option>
          {actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <input name="q" defaultValue={f.q ?? ""} placeholder="Action contains…" className={FILTER} />
        <button type="submit" className="rounded-full px-4 py-2 text-sm"
          style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}>
          Filter
        </button>
        {(f.entity_type || f.actor || f.q) && (
          <Link href="/audit" className="text-sm" style={{ color: "var(--yg-pink)" }}>Clear</Link>
        )}
      </form>

      {pageRows.length === 0 ? (
        <Empty>Nothing matches those filters.</Empty>
      ) : (
        /*
         * Entries, not a table. Five columns with a JSON diff in the last one is a
         * thousand pixels of row; the log is read at 3am by somebody working out
         * what happened, and often on a phone.
         */
        <ol className="flex flex-col gap-2">
          {pageRows.map((e) => {
            const href = HREF[e.entityType]?.(e.entityId);
            return (
              <li
                key={e.id}
                className="flex flex-col gap-2 rounded-[var(--r-card)] p-4 sm:flex-row sm:gap-4"
                style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
              >
                <time
                  className="tnum shrink-0 text-[11.5px] text-text-muted sm:w-[132px]"
                  dateTime={new Date(e.createdAt).toISOString()}
                >
                  {new Date(e.createdAt).toLocaleString("en-IN", {
                    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
                  })}
                </time>

                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="text-[13.5px]">
                    <span className="text-text-soft">{e.actor ?? "System"}</span>{" "}
                    <span className="tnum text-[12.5px]">{e.action}</span>{" "}
                    {href ? (
                      <Link href={href} style={{ color: "var(--yg-pink)" }}>
                        {e.entityType.toLowerCase().replace("_", " ")}
                      </Link>
                    ) : (
                      <span className="text-text-muted">{e.entityType.toLowerCase().replace("_", " ")}</span>
                    )}
                  </p>
                  <div className="text-[12px] break-words text-text-muted">
                    <Diff before={e.before} after={e.after} />
                    {e.reason && <p className="mt-1 text-text-soft">&ldquo;{e.reason}&rdquo;</p>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {more && (
        <p className="mt-4 text-sm">
          <Link href={qs({ before: pageRows[pageRows.length - 1].createdAt.toISOString() })} style={{ color: "var(--yg-pink)" }}>
            Older →
          </Link>
        </p>
      )}
    </>
  );
}

const FILTER = "rounded-lg px-3 py-2 text-sm bg-[var(--yg-bg-app)] border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

/** Only the fields that actually moved — a full JSON dump is unreadable at 3am. */
function Diff({ before, after }: { before: unknown; after: unknown }) {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])]
    .filter((k) => JSON.stringify(b[k]) !== JSON.stringify(a[k]));

  if (keys.length === 0) return <span>—</span>;

  return (
    <ul className="space-y-0.5">
      {keys.slice(0, 4).map((k) => (
        <li key={k} className="tnum">
          {k}: {fmt(b[k])} → <span className="text-text-soft">{fmt(a[k])}</span>
        </li>
      ))}
      {keys.length > 4 && <li>+{keys.length - 4} more</li>}
    </ul>
  );
}

function fmt(v: unknown): string {
  if (v === undefined || v === null) return "—";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 28 ? `${s.slice(0, 28)}…` : s;
}
