import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { Camera, CheckCheck, CircleDot, Clock, MessagesSquare, Receipt, Shield, Wallet } from "lucide-react";
import { db } from "@/db";
import { departments, reimbursementRequests } from "@/db/schema";
import { getSession, type SessionUser } from "@/lib/session";
import { can } from "@/lib/authz";
import { departmentTotals, departmentTotalsForFest, festTotals } from "@/lib/queries/budget";
import { approvalQueue, endorsementQueue, paymentQueue, type QueueItem } from "@/lib/queries/queues";
import { openFlagCounts, listFlags } from "@/lib/services/flags";
import { readAuditLog } from "@/lib/services/audit";
import { stalledStages } from "@/lib/queries/stalled";
import { formatPaise } from "@/lib/money";
import {
  Amount, buttonClass, buttonStyle, Card, Empty, PageTitle, SectionHeading, StateChip,
} from "@/components/ui";
import { AvailableCard, AvailableHero, availableTone } from "@/components/five-numbers";
import { StalledNotice } from "@/components/stalled";

/**
 * PRD 9 — Finance and Management get the fest overview; HODs and Members their own.
 *
 * The redesign's change here is hierarchy. It was a wall of eight equal StatCards
 * followed by a table, which told nobody where to look. Now the page opens with the
 * one sentence that matters — what is waiting on *you* — and the single figure the
 * whole product is about, with the queue that produced it beside them. Everything
 * else is supporting and is drawn that way.
 */
export default async function DashboardPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const festWide = can(user, "income.view", scope); // Finance HOD and Management (5.1)

  if (festWide) return <FestOverview user={user} />;
  // A Member is not shown their department's budget at all (5.1) — what they get is
  // their own work, which is a different page rather than a redacted one.
  return can(user, "department.budget.view", scope)
    ? <DepartmentOverview user={user} />
    : <MemberOverview user={user} />;
}

/**
 * A Member's dashboard.
 *
 * They spend out of a budget without being shown it, so there is no figure on this
 * page that is not their own money. What is left is the two things they actually
 * open the app for: a receipt to claim, and whatever is waiting on them.
 */
async function MemberOverview({ user }: { user: SessionUser }) {
  const mine = await db.select({
    id: reimbursementRequests.id,
    humanId: reimbursementRequests.humanId,
    status: reimbursementRequests.status,
    description: reimbursementRequests.description,
    amountPaise: reimbursementRequests.amountPaise,
  }).from(reimbursementRequests)
    .where(and(
      eq(reimbursementRequests.festId, user.festId),
      eq(reimbursementRequests.submitterId, user.id),
      isNull(reimbursementRequests.deletedAt),
    ))
    .orderBy(desc(reimbursementRequests.createdAt))
    .limit(5);

  const settled = ["PAID", "DECLINED", "WITHDRAWN"];
  const inFlight = mine.filter((r) => !settled.includes(r.status));
  const owed = inFlight.reduce((n, r) => n + r.amountPaise, 0);

  return (
    <>
      <PageTitle
        subtitle={
          inFlight.length > 0
            ? <>You are waiting on <span className="tnum">{formatPaise(owed)}</span> across{" "}
                {inFlight.length} {inFlight.length === 1 ? "claim" : "claims"}.</>
            : "Nothing of yours is in the queue."
        }
        action={
          <Link href="/requests/new" className={buttonClass("hero")} style={buttonStyle("hero")}>
            <Camera size={17} aria-hidden />
            Claim a receipt
          </Link>
        }
      >
        {user.name.split(/\s+/)[0]}&rsquo;s work
      </PageTitle>

      {mine.length === 0 ? (
        <Empty
          icon={<Receipt size={24} aria-hidden />}
          title="Nothing claimed yet"
          action={
            <Link href="/requests/new" className={buttonClass("primary")} style={buttonStyle("primary")}>
              <Camera size={16} aria-hidden /> Photograph a receipt
            </Link>
          }
        >
          When you pay for something out of pocket, photograph the receipt here.
          {" "}{user.departmentName}&rsquo;s head sees it within minutes, and Finance approves it
          after that.
        </Empty>
      ) : (
        <section className="flex flex-col gap-3">
          <SectionHeading
            aside={
              <Link href="/requests" className="text-[12.5px]" style={{ color: "var(--yg-pink)" }}>
                All of yours →
              </Link>
            }
          >
            Your claims
          </SectionHeading>
          <div className="flex flex-col gap-2.5">
            {mine.map((r) => (
              <Link
                key={r.id}
                href={`/requests/${r.id}`}
                className="flex flex-col gap-2 rounded-[var(--r-card)] p-4 hover:border-lime sm:flex-row sm:items-center sm:gap-4"
                style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="tnum text-[11.5px] text-text-muted">{r.humanId}</span>
                    <StateChip state={r.status} />
                  </span>
                  <span className="text-[14px]">{r.description}</span>
                </span>
                <span className="tnum text-[15px]"><Amount paise={r.amountPaise} /></span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Link
          href="/tickets"
          className="flex items-center gap-3 rounded-[var(--r-card)] p-4 hover:border-lime"
          style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
        >
          <CircleDot size={18} style={{ color: "var(--yg-lime)" }} aria-hidden />
          <span className="text-[13.5px]">Ask {user.departmentName}&rsquo;s head for something</span>
        </Link>
        <Link
          href="/chat"
          className="flex items-center gap-3 rounded-[var(--r-card)] p-4 hover:border-lime"
          style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
        >
          <MessagesSquare size={18} style={{ color: "var(--yg-lime)" }} aria-hidden />
          <span className="text-[13.5px]">{user.departmentName}&rsquo;s channels</span>
        </Link>
      </div>
    </>
  );
}

/** "Nine things are waiting on you" — the queue this person actually owns. */
async function myQueue(user: SessionUser): Promise<{ items: QueueItem[]; verb: string; href: string }> {
  const scope = { festId: user.festId, departmentId: user.departmentId };
  if (can(user, "reimbursement.recordPayment", { ...scope, submitterId: "x" })) {
    return { items: await paymentQueue(user), verb: "pay", href: "/queues" };
  }
  if (can(user, "reimbursement.approve", { ...scope, submitterId: "x" })) {
    return { items: await approvalQueue(user), verb: "approve", href: "/queues" };
  }
  if (user.role === "DEPT_HOD") {
    return { items: await endorsementQueue(user), verb: "endorse", href: "/queues" };
  }
  return { items: [], verb: "", href: "/queues" };
}

const HOURS = (since: Date) => (Date.now() - new Date(since).getTime()) / 3_600_000;

async function FestOverview({ user }: { user: SessionUser }) {
  const [totals, rows, deptTotals, queue, flagCounts, flags, activity, stalled] = await Promise.all([
    festTotals(user.festId),
    db.select({ id: departments.id, name: departments.name, kind: departments.kind })
      .from(departments)
      .where(and(eq(departments.festId, user.festId), eq(departments.isActive, true)))
      .orderBy(asc(departments.name)),
    departmentTotalsForFest(user.festId),
    myQueue(user),
    openFlagCounts(user),
    listFlags(user, { status: "OPEN", limit: 4 }),
    readAuditLog(user, { limit: 5 }).catch(() => []),
    stalledStages(user),
  ]);

  if (!totals) {
    return (
      <Empty icon={<Wallet size={24} aria-hidden />} title="This fest has no budget yet">
        Set the total from Admin, then create departments and allocate to them. Every number on
        every screen is derived from what happens after that.
      </Empty>
    );
  }

  const byDept = new Map(deptTotals.map((t) => [t.departmentId, t]));
  const fest = {
    allocatedPaise: totals.allocatedPaise,
    pendingPaise: deptTotals.reduce((n, t) => n + t.pendingPaise, 0),
    committedPaise: deptTotals.reduce((n, t) => n + t.committedPaise, 0),
    spentPaise: deptTotals.reduce((n, t) => n + t.spentPaise, 0),
    availablePaise: deptTotals.reduce((n, t) => n + t.availablePaise, 0),
  };

  const waiting = queue.items.length;
  const stale = queue.items.filter((q) => HOURS(q.waiting_since) > 36).length;

  // Closest to their cap first — the ones an HOD is about to ask you about.
  const nearCap = [...deptTotals]
    .filter((t) => t.allocatedPaise > 0)
    .sort((a, b) => a.availablePaise / a.allocatedPaise - b.availablePaise / b.allocatedPaise)
    .slice(0, 4)
    .map((t) => ({ ...t, name: rows.find((r) => r.id === t.departmentId)?.name ?? "—" }));

  return (
    <>
      <PageTitle
        subtitle={
          waiting > 0
            ? `${waiting} ${waiting === 1 ? "thing is" : "things are"} waiting on you. Everything else is on track.`
            : "Nothing is waiting on you."
        }
        action={
          waiting > 0 && (
            <Link href={queue.href} className={buttonClass("hero")} style={buttonStyle("hero")}>
              <CheckCheck size={17} aria-hidden />
              {queue.verb === "pay" ? `Pay ${waiting}` : `Approve ${waiting}`}
            </Link>
          )
        }
      >
        Fest overview
      </PageTitle>

      <StalledNotice
        stages={stalled}
        canFix={can(user, "user.manage", { festId: user.festId })}
        className="mb-[var(--gap-section)]"
      />

      <div className="grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <AvailableHero
          label="Fest available"
          totals={fest}
          caption={`of ${formatPaise(totals.allocatedPaise)} allocated · ${formatPaise(totals.reservePaise)} still in Reserve`}
        />

        <Card>
          <SectionHeading
            aside={
              waiting > 0 ? (
                <span
                  className="tnum rounded-full px-2.5 py-1 text-[12px]"
                  style={{ background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }}
                >
                  {waiting}
                </span>
              ) : null
            }
          >
            {queue.verb === "pay" ? "Your payment queue" : "Your approval queue"}
          </SectionHeading>

          {queue.items.length === 0 ? (
            <p className="mt-4 text-[13px] text-text-muted">
              Nothing is waiting on your decision.
            </p>
          ) : (
            <ul className="mt-4 flex flex-col gap-2.5">
              {queue.items.slice(0, 4).map((q) => (
                <li key={q.id}>
                  <Link
                    href={q.kind === "REIMBURSEMENT" ? `/requests/${q.id}` : `/vendors/requests/${q.id}`}
                    className="flex items-center gap-3 rounded-[var(--r-control)] p-[11px_14px] hover:border-lime"
                    style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
                  >
                    <span
                      className="flex size-[34px] shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold"
                      style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                      aria-hidden
                    >
                      {q.submitter.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join("")}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[13px]">{q.line_item ?? q.title}</span>
                      <span className="text-[11px] text-text-muted">
                        {q.submitter} · {q.department} · {Math.round(HOURS(q.waiting_since))}h
                      </span>
                    </span>
                    <span className="tnum shrink-0 text-[13.5px]">{formatPaise(q.amount_paise)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {stale > 0 && (
            <p
              className="mt-4 flex items-center gap-2 rounded-[12px] px-3.5 py-2.5 text-[12.5px]"
              style={{ background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }}
            >
              <Clock size={15} className="shrink-0" aria-hidden />
              {stale === 1 ? "One has" : `${stale} have`} been waiting more than 36 hours
            </p>
          )}
        </Card>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        <Card>
          <p className="meta-label">Departments closest to their cap</p>
          <ul className="mt-4 flex flex-col gap-3.5">
            {nearCap.map((t) => (
              <li key={t.departmentId} className="flex flex-col gap-1.5">
                <div className="flex justify-between gap-3">
                  <Link href={`/budget/${t.departmentId}`} className="text-[13px] hover:text-lime">
                    {t.name}
                  </Link>
                  <span className="tnum text-[12.5px]" style={{ color: availableTone(t) }}>
                    {formatPaise(t.availablePaise)}
                  </span>
                </div>
                <span className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--yg-surface-2)" }}>
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.min(100, 100 - (t.availablePaise / Math.max(t.allocatedPaise, 1)) * 100)}%`,
                      background: availableTone(t),
                    }}
                  />
                </span>
              </li>
            ))}
            {nearCap.length === 0 && <li className="text-[13px] text-text-muted">No department has an allocation yet.</li>}
          </ul>
        </Card>

        <Card>
          <p className="meta-label">
            Flags needing a decision
            {flagCounts.total > 0 && <span className="tnum ml-2 normal-case">{flagCounts.total}</span>}
          </p>
          <ul className="mt-4 flex flex-col gap-3">
            {flags.length === 0 && (
              <li className="text-[13px] text-text-muted">
                Nothing is flagged. The rules re-run on every write, so this stays current on its own.
              </li>
            )}
            {flags.map((f) => {
              const row = f as Record<string, string>;
              return (
                <li key={row.id} className="flex gap-3 pb-3" style={{ borderBottom: "1px solid var(--yg-surface-2)" }}>
                  <span
                    className="mt-1.5 size-2 shrink-0 rounded-full"
                    style={{ background: `var(--flag-${row.severity.toLowerCase()}-fg)` }}
                    aria-hidden
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-[12.5px] leading-snug">{row.explanation}</span>
                    <span className="tnum text-[10.5px] text-text-muted">{row.rule}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {flags.length > 0 && (
            <Link href="/flags" className="mt-3 inline-block text-[12.5px]" style={{ color: "var(--yg-pink)" }}>
              All flags →
            </Link>
          )}
        </Card>

        <Card>
          <p className="meta-label">On the record today</p>
          <ul className="mt-4 flex flex-col gap-2.5">
            {activity.length === 0 && (
              <li className="text-[13px] text-text-muted">Nothing has happened yet today.</li>
            )}
            {activity.map((a) => (
              <li key={String(a.id)} className="flex items-baseline gap-3">
                <span className="tnum w-10 shrink-0 text-[11px] text-text-muted">
                  {new Date(a.created_at as string | Date).toLocaleTimeString("en-IN", {
                    hour: "2-digit", minute: "2-digit", hour12: false,
                  })}
                </span>
                <span className="text-[12.5px] leading-snug text-text-soft">
                  {String(a.actor ?? "Somebody")} · {String(a.action).replaceAll(".", " ").replaceAll("_", " ")}
                </span>
              </li>
            ))}
          </ul>
          {can(user, "audit.view", { festId: user.festId }) && (
            <p className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: "var(--yg-sky)" }}>
              <Shield size={14} aria-hidden />
              You see the full log as an administrator
            </p>
          )}
        </Card>
      </div>

      <div className="mt-8">
        <SectionHeading aside={<Link href="/budget" className="text-[12.5px]" style={{ color: "var(--yg-pink)" }}>All departments →</Link>}>
          Departments
        </SectionHeading>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.filter((d) => d.kind === "BUDGET").map((d) => {
            const t = byDept.get(d.id);
            if (!t) return null;
            return (
              <AvailableCard
                key={d.id}
                href={`/budget/${d.id}`}
                label={d.name}
                totals={t}
                caption={
                  <>
                    of <Amount paise={t.allocatedPaise} />
                    {t.pendingPaise > 0 && <> · <Amount paise={t.pendingPaise} /> held back</>}
                  </>
                }
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

async function DepartmentOverview({ user }: { user: SessionUser }) {
  const [t, queue] = await Promise.all([
    departmentTotals(user.departmentId),
    myQueue(user),
  ]);

  if (!t) {
    return (
      <Empty icon={<Wallet size={24} aria-hidden />} title="No budget yet">
        {user.departmentName} has not been allocated anything. Once Finance does, this is where
        you will see what is left of it.
      </Empty>
    );
  }

  const waiting = queue.items.length;

  return (
    <>
      <PageTitle
        subtitle={
          waiting > 0
            ? `${waiting} ${waiting === 1 ? "request is" : "requests are"} waiting on you to endorse.`
            : `What ${user.departmentName} has left, and what it is committed to.`
        }
        action={
          <Link href="/requests/new" className={buttonClass("hero")} style={buttonStyle("hero")}>
            <Camera size={17} aria-hidden />
            Claim a receipt
          </Link>
        }
      >
        {user.departmentName}
      </PageTitle>

      <AvailableHero
        label={`${user.departmentName} · available`}
        totals={t}
        caption={
          t.pendingPaise > 0
            ? `${formatPaise(t.pendingPaise)} is held back for requests awaiting a decision`
            : `of ${formatPaise(t.allocatedPaise)} allocated`
        }
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <Link
          href={`/budget/${user.departmentId}`}
          className="flex items-center gap-3 rounded-[var(--r-card)] p-4 hover:border-lime"
          style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
        >
          <Wallet size={18} style={{ color: "var(--yg-lime)" }} aria-hidden />
          <span className="text-[13.5px]">Line items — what is left in each pot</span>
        </Link>
        <Link
          href="/requests"
          className="flex items-center gap-3 rounded-[var(--r-card)] p-4 hover:border-lime"
          style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
        >
          <Receipt size={18} style={{ color: "var(--yg-lime)" }} aria-hidden />
          <span className="text-[13.5px]">
            {waiting > 0 ? `${waiting} to endorse` : "Your reimbursements"}
          </span>
        </Link>
      </div>
    </>
  );
}
