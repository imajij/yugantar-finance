import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Archive, Bell, Camera, ClipboardList, CircleDot, FileText, Flag, Gauge, HandCoins,
  Home, MessagesSquare, ScrollText, Settings, Truck, Users, Wallet,
} from "lucide-react";
import { getSession, clerkConfigured } from "@/lib/session";
import { can, type Action } from "@/lib/authz";
import { unreadCount } from "@/lib/services/notifications";
import { unreadTotal } from "@/lib/services/chat";
import { openFlagCounts } from "@/lib/services/flags";
import { SignOutButton } from "@/components/sign-out";

/** Every page here reads the session cookie, so none of them may be prerendered. */
export const dynamic = "force-dynamic";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Gauge;
  action: Action;
  /** The count worth interrupting somebody for. */
  badge?: "messages" | "flags" | "notifications";
  /** An amber badge is a queue with your name on it, not a tally. */
  hot?: boolean;
}

/**
 * Twelve flat entries became three groups.
 *
 * The grouping is the actual mental model: **money** is the ledger and everything
 * that moves it, **work** is what people are doing to each other, **oversight** is
 * what somebody reviews afterwards. A flat list made "Audit log" a sibling of
 * "Reimbursements", which they have never been.
 *
 * Sidebar entries are filtered by the same `can` the API enforces (18.2 rule 1).
 */
const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Money",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: Gauge, action: "fest.view" },
      { href: "/budget", label: "Budget", icon: Wallet, action: "department.budget.view" },
      { href: "/requests", label: "Reimbursements", icon: FileText, action: "reimbursement.create" },
      { href: "/queues", label: "Queues", icon: ClipboardList, action: "reimbursement.create", hot: true },
      { href: "/vendors", label: "Vendors", icon: Truck, action: "vendor.view" },
      { href: "/income", label: "Income", icon: HandCoins, action: "income.view" },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/tickets", label: "Tickets", icon: CircleDot, action: "ticket.create" },
      { href: "/chat", label: "Channels", icon: MessagesSquare, action: "fest.view", badge: "messages" },
      { href: "/team", label: "Team", icon: Users, action: "user.manageOwnTeam" },
    ],
  },
  {
    label: "Oversight",
    items: [
      { href: "/flags", label: "Flags", icon: Flag, action: "flag.view", badge: "flags" },
      { href: "/close-out", label: "Close-out", icon: Archive, action: "closeOut.view" },
      { href: "/audit", label: "Audit log", icon: ScrollText, action: "audit.view" },
      { href: "/admin", label: "Admin", icon: Settings, action: "user.manage" },
    ],
  },
];

/**
 * The phone's navigation. Five destinations, thumb-reachable, and deliberately not
 * the sidebar shrunk down — the horizontally scrolling strip of twelve pills it
 * replaces hid most of itself off-screen.
 *
 * "Claim" is the camera. It is the thing a Member opens the app to do at 11pm, and
 * it earns a permanent place over anything they would only read.
 */
const TABS: { href: string; label: string; icon: typeof Home; action: Action }[] = [
  { href: "/dashboard", label: "Home", icon: Home, action: "fest.view" },
  { href: "/budget", label: "Budget", icon: Wallet, action: "department.budget.view" },
  { href: "/requests/new", label: "Claim", icon: Camera, action: "reimbursement.create" },
  { href: "/tickets", label: "Tickets", icon: CircleDot, action: "ticket.create" },
  { href: "/chat", label: "Chat", icon: MessagesSquare, action: "fest.view" },
];

const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("") || "?";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const [unread, unreadMessages, flags] = await Promise.all([
    unreadCount(user), unreadTotal(user), openFlagCounts(user),
  ]);

  const counts = { messages: unreadMessages, flags: flags.total, notifications: unread };
  const groups = GROUPS
    .map((g) => ({
      ...g,
      items: g.items.filter((n) => can(user, n.action, scope)),
    }))
    .filter((g) => g.items.length > 0);
  const tabs = TABS.filter((t) => can(user, t.action, scope));

  return (
    <div className="flex min-h-screen">
      {/* ------------------------------------------------------------ sidebar */}
      <aside
        className="hidden w-[244px] shrink-0 flex-col gap-[22px] overflow-y-auto p-[22px_14px] md:flex"
        style={{ background: "var(--yg-surface)", borderRight: "1px solid var(--yg-surface-2)" }}
      >
        <Link href="/dashboard" className="flex items-center gap-2.5 px-2">
          <span
            className="font-display flex size-8 items-center justify-center rounded-[11px] text-[19px] font-bold"
            style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
            aria-hidden
          >
            Y
          </span>
          <span className="font-display text-[14px]">Yugaantar &rsquo;26</span>
        </Link>

        <nav className="flex flex-col gap-[22px]">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-[3px]">
              <p
                className="font-display px-2.5 pb-[7px] text-[10px] tracking-[0.18em] text-text-muted uppercase"
              >
                {group.label}
              </p>
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} count={item.badge ? counts[item.badge] : 0} />
              ))}
            </div>
          ))}

          <div className="flex flex-col gap-[3px]">
            <p className="font-display px-2.5 pb-[7px] text-[10px] tracking-[0.18em] text-text-muted uppercase">
              You
            </p>
            <NavLink
              item={{ href: "/notifications", label: "Notifications", icon: Bell, action: "fest.view" }}
              count={unread}
            />
          </div>
        </nav>

        <div className="mt-auto flex flex-col gap-2.5">
          <div
            className="flex items-center gap-2.5 rounded-[var(--r-control)] p-2.5"
            style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
          >
            <span
              className="flex size-[30px] shrink-0 items-center justify-center rounded-full text-[12px] font-bold"
              style={{ background: "var(--yg-pink)", color: "var(--yg-on-accent)" }}
              aria-hidden
            >
              {initials(user.name)}
            </span>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[12.5px]">{user.name}</span>
              <span className="text-[10.5px] text-text-muted">
                {user.departmentName} · {user.role.replace("_", " ").toLowerCase()}
                {user.isSuperAdmin ? " · admin" : ""}
              </span>
            </div>
          </div>
          <SignOutButton withClerk={clerkConfigured()} />
        </div>
      </aside>

      {/* --------------------------------------------------------------- main */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-20 md:hidden"
          style={{ background: "var(--yg-surface)", borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-2.5">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span
                className="font-display flex size-7 items-center justify-center rounded-[10px] text-[16px] font-bold"
                style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
                aria-hidden
              >
                Y
              </span>
              <span className="font-display text-[14px]">Yugaantar &rsquo;26</span>
            </Link>
            <Link href="/notifications" className="tap relative text-text-soft" aria-label="Notifications">
              <Bell size={19} aria-hidden />
              {unread > 0 && (
                <span
                  className="absolute top-1.5 right-1.5 size-2 rounded-full"
                  style={{ background: "var(--yg-lime)" }}
                  aria-label={`${unread} unread`}
                />
              )}
            </Link>
          </div>
        </header>

        {/*
          `min-h-0` so a child can be a fixed two-pane layout (chat) rather than
          every screen having to be a scrolling document. The bottom padding on
          small screens clears the tab bar.
        */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-5 pb-24 md:px-7 md:py-8 md:pb-8">
          {children}
        </main>

        <nav
          className="fixed inset-x-0 bottom-0 z-20 flex justify-around gap-1 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
          style={{ background: "var(--yg-surface)", borderTop: "1px solid var(--yg-surface-2)" }}
          aria-label="Primary"
        >
          {tabs.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex min-w-[var(--row-h)] flex-col items-center gap-1 py-1 text-[10px] text-text-muted"
            >
              <span className="flex h-9 w-[var(--row-h)] items-center justify-center rounded-xl">
                <Icon size={18} aria-hidden />
              </span>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}

function NavLink({ item, count }: { item: NavItem; count: number }) {
  const { href, label, icon: Icon, hot } = item;
  return (
    <Link
      href={href}
      className="flex h-10 items-center gap-[11px] rounded-xl px-2.5 text-[13.5px] text-text-soft hover:bg-surface-2 hover:text-text"
    >
      <Icon size={16} className="shrink-0" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && (
        <span
          className="tnum rounded-full px-2 py-0.5 text-[11px]"
          style={
            hot
              ? { background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }
              : { background: "var(--yg-surface-2)", color: "var(--yg-text-muted)" }
          }
          aria-label={`${count} waiting`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
