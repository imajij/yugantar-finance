import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditEvents, users } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { Card, Empty, PageTitle } from "@/components/ui";

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
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Who</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Entity</th>
                <th className="px-4 py-3 font-medium">Change</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((e) => {
                const href = HREF[e.entityType]?.(e.entityId);
                return (
                  <tr key={e.id} style={{ borderTop: "1px solid var(--yg-surface-2)" }} className="align-top">
                    <td className="tnum px-4 py-3 text-xs whitespace-nowrap text-text-muted">
                      {new Date(e.createdAt).toLocaleString("en-IN")}
                    </td>
                    <td className="px-4 py-3 text-text-soft">{e.actor ?? "System"}</td>
                    <td className="px-4 py-3">{e.action}</td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      {href
                        ? <Link href={href} style={{ color: "var(--yg-pink)" }}>{e.entityType.toLowerCase()}</Link>
                        : e.entityType.toLowerCase()}
                    </td>
                    <td className="px-4 py-3 text-xs text-text-muted">
                      <Diff before={e.before} after={e.after} />
                      {e.reason && <p className="mt-1 text-text-soft">&ldquo;{e.reason}&rdquo;</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
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
