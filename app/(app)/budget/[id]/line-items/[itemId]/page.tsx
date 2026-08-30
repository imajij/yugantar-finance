import Link from "next/link";
import { notFound as nf, redirect } from "next/navigation";
import { and, desc, eq, isNull } from "drizzle-orm";
import { AlertTriangle, FileText, Link2 } from "lucide-react";
import { db } from "@/db";
import {
  attachments, auditEvents, comments, departments, flags, lineItems,
  reimbursementRequests, users, vendorRequests, vendors,
} from "@/db/schema";
import { getSession } from "@/lib/session";
import { can, satisfiesActorConstraints } from "@/lib/authz";
import { LINE_ITEM_TRANSITIONS } from "@/lib/state-machines/line-item";
import { lineItemTotals } from "@/lib/queries/budget";
import { Amount, Card, Empty, FlagChip, PageTitle, StatCard, StateChip } from "@/components/ui";
import { RaiseConcern } from "@/components/raise-flag";
import { TransitionActions } from "@/components/transitions";
import { Timeline } from "@/components/timeline";
import { CommentThread } from "@/components/comments";
import { AddDocument, RemoveDocument } from "./documents";

/**
 * PRD 20.5 — one line item: its five numbers, its quotes, and every request
 * charged against it. This is where "where did the money go?" gets answered.
 */
export default async function LineItemPage({
  params,
}: { params: Promise<{ id: string; itemId: string }> }) {
  const { id: deptId, itemId } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const [item] = await db.select().from(lineItems)
    .where(and(eq(lineItems.id, itemId), eq(lineItems.festId, user.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!item) nf();
  if (!can(user, "lineItem.view", { festId: user.festId, departmentId: item.departmentId })) nf();

  const [totals, docs, openFlags, timeline, claims, purchases, [dept], thread] = await Promise.all([
    lineItemTotals(item.id),
    db.select().from(attachments).where(and(
      eq(attachments.entityType, "LINE_ITEM"), eq(attachments.entityId, item.id), isNull(attachments.removedAt),
    )),
    db.select().from(flags).where(and(
      eq(flags.entityType, "LINE_ITEM"), eq(flags.entityId, item.id), eq(flags.status, "OPEN"),
    )),
    db.select({ action: auditEvents.action, reason: auditEvents.reason, createdAt: auditEvents.createdAt, actor: users.name })
      .from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(and(eq(auditEvents.entityType, "LINE_ITEM"), eq(auditEvents.entityId, item.id)))
      .orderBy(auditEvents.createdAt),
    db.select({
      id: reimbursementRequests.id, humanId: reimbursementRequests.humanId,
      status: reimbursementRequests.status, amountPaise: reimbursementRequests.amountPaise,
      description: reimbursementRequests.description, who: users.name,
    })
      .from(reimbursementRequests).innerJoin(users, eq(users.id, reimbursementRequests.submitterId))
      .where(and(eq(reimbursementRequests.lineItemId, item.id), isNull(reimbursementRequests.deletedAt)))
      .orderBy(desc(reimbursementRequests.createdAt)),
    db.select({
      id: vendorRequests.id, humanId: vendorRequests.humanId, status: vendorRequests.status,
      totalValuePaise: vendorRequests.totalValuePaise, approvedValuePaise: vendorRequests.approvedValuePaise,
      description: vendorRequests.description, who: vendors.name,
    })
      .from(vendorRequests).innerJoin(vendors, eq(vendors.id, vendorRequests.vendorId))
      .where(and(eq(vendorRequests.lineItemId, item.id), isNull(vendorRequests.deletedAt)))
      .orderBy(desc(vendorRequests.createdAt)),
    db.select({ name: departments.name }).from(departments).where(eq(departments.id, item.departmentId)).limit(1),
    db.select({
      id: comments.id, body: comments.body, author: users.name,
      createdAt: comments.createdAt, editedAt: comments.editedAt,
    })
      .from(comments).innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.entityType, "LINE_ITEM"), eq(comments.entityId, item.id)))
      .orderBy(comments.createdAt),
  ]);

  const resource = { festId: user.festId, departmentId: item.departmentId, status: item.status };
  const actions = LINE_ITEM_TRANSITIONS
    .filter((t) => t.from === item.status)
    .filter((t) => t.roles.includes(user.role))
    .filter((t) => satisfiesActorConstraints(t.actor, user, resource))
    .filter((t) => can(user,
      t.action.endsWith("REVIEWED") ? "lineItem.markReviewed" : "lineItem.close", resource))
    .map((t) => ({ action: t.action, requires: [...(t.requires ?? [])] }));

  const quotes = docs
    .map((d) => ({ ...d, quotedAmountPaise: d.quotedAmountPaise }))
    .filter((d) => d.quotedAmountPaise != null);
  const lowest = quotes.length ? Math.min(...quotes.map((q) => q.quotedAmountPaise!)) : null;

  // Linked through the API rather than to a signed URL minted here — the signature
  // is short-lived and would go stale on a page somebody left open.
  const files = docs.map((d) => ({
    id: d.id,
    kind: d.kind,
    // A link has no file name; its label is what it is called.
    name: d.label ?? d.fileName ?? (d.kind === "LINK" ? "Web listing" : "document"),
    url: d.url,
    source: d.sourceName,
    quoted: d.quotedAmountPaise,
  }));

  const canManageDocs = can(user, "lineItem.document.manage", {
    festId: user.festId, departmentId: item.departmentId,
  });

  return (
    <div className="max-w-3xl">
      <p className="mb-2 text-sm">
        <Link href={`/budget/${deptId}`} style={{ color: "var(--yg-accent)" }}>← {dept?.name}</Link>
      </p>
      <PageTitle
        action={
          <div className="flex flex-wrap items-center gap-2">
            <RaiseConcern
              entityType="LINE_ITEM"
              entityId={item.id}
              allowed={can(user, "flag.raise", { festId: user.festId, departmentId: user.departmentId })}
            />
            <StateChip state={item.status} />
          </div>
        }
      >
        {item.name}
      </PageTitle>

      {item.description && <p className="mb-4 text-sm text-text-soft">{item.description}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard label="Planned" paise={item.plannedPaise} />
        <StatCard label="Pending" paise={totals?.pendingPaise ?? 0} tone="waiting" />
        <StatCard label="Committed" paise={totals?.committedPaise ?? 0} tone="decided" />
        <StatCard label="Spent" paise={totals?.spentPaise ?? 0} tone="done" />
        <StatCard label="Available" paise={totals?.availablePaise ?? item.plannedPaise} />
      </div>

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

      <Card className="mt-4">
        <h2 className="font-display text-sm">Quotes and documents</h2>
        {files.length === 0 ? (
          <p className="mt-2 text-[13.5px] text-text-muted">
            Nothing attached yet. A quotation, a proforma invoice or a link to the page you are
            pricing from &mdash; three quotes for one item is the normal case, and it is what lets
            Finance see the basis for the number.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-1.5">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex items-center gap-3 rounded-[var(--r-control)] px-3 py-2"
                style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
              >
                {f.kind === "LINK" ? (
                  <Link2 size={15} className="shrink-0 text-text-muted" aria-hidden />
                ) : (
                  <FileText size={15} className="shrink-0 text-text-muted" aria-hidden />
                )}
                <span className="flex min-w-0 flex-1 flex-col">
                  <a
                    href={f.kind === "LINK" && f.url ? f.url : `/api/v1/attachments/${f.id}/url?redirect=1`}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-[13.5px]"
                    style={{ color: "var(--yg-accent)" }}
                  >
                    {f.name}
                  </a>
                  {f.source && <span className="text-[11.5px] text-text-muted">{f.source}</span>}
                </span>
                {f.quoted != null && (
                  <span
                    className="tnum shrink-0 text-[13px]"
                    style={{ color: f.quoted === lowest ? "var(--yg-accent)" : "var(--yg-text-muted)" }}
                  >
                    <Amount paise={f.quoted} />
                  </span>
                )}
                <RemoveDocument
                  lineItemId={item.id}
                  attachmentId={f.id}
                  name={f.name}
                  canManage={canManageDocs}
                />
              </li>
            ))}
          </ul>
        )}

        {lowest !== null && quotes.length > 1 && (
          <p className="mt-3 text-[12px] text-text-muted">
            Lowest quote <Amount paise={lowest} /> &mdash; highlighted. Planning above it raises a flag,
            which does not block anything; it asks somebody to say why.
          </p>
        )}

        <AddDocument lineItemId={item.id} canManage={canManageDocs} />
      </Card>

      {actions.length > 0 && (
        <Card className="mt-4">
          <h2 className="font-display text-sm">Actions</h2>
          <TransitionActions endpoint={`/api/v1/line-items/${item.id}/transitions`} actions={actions} />
        </Card>
      )}

      <Card className="mt-4">
        <h2 className="font-display text-sm">Charged against this line item</h2>
        {claims.length === 0 && purchases.length === 0 ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {claims.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/requests/${c.id}`} className="min-w-0" style={{ color: "var(--yg-accent)" }}>
                  <span className="tnum text-xs text-text-muted">{c.humanId}</span> {c.description}
                </Link>
                <span className="flex items-center gap-2">
                  <StateChip state={c.status} />
                  <Amount paise={c.amountPaise} />
                </span>
              </li>
            ))}
            {purchases.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/vendors/requests/${p.id}`} className="min-w-0" style={{ color: "var(--yg-accent)" }}>
                  <span className="tnum text-xs text-text-muted">{p.humanId}</span> {p.who} — {p.description}
                </Link>
                <span className="flex items-center gap-2">
                  <StateChip state={p.status} />
                  <Amount paise={p.approvedValuePaise ?? p.totalValuePaise} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Timeline events={timeline} />

      <CommentThread entityType="LINE_ITEM" entityId={item.id} comments={thread} />
    </div>
  );
}
