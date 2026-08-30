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
import { NavLink, TabLink } from "@/components/nav-link";

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

  /*
   * The shell is the viewport, and nothing outside it scrolls.
   *
   * It used to be `min-h-screen`, which made the whole app one long document: the
   * sidebar scrolled away with the content, the mobile header had to be `sticky`
   * to survive, the tab bar had to be `fixed` and every page had to leave 96px of
   * padding underneath it. Three workarounds for one decision.
   *
   * Now the frame is fixed at `h-dvh` (dynamic, so a phone's disappearing browser
   * chrome does not cut the bottom off) and each region scrolls inside its own
   * box — the sidebar its nav, `main` its page. Chat gets a whole two-pane layout
   * for free, because a child asking to fill the height is now asking for
   * something that exists.
   */
  return (
    <div className="flex h-dvh overflow-hidden">
      {/* ------------------------------------------------------------ sidebar */}
      {/*
        The sidebar, at Linear's density: a 32px row, a 16px glyph, and enough of
        them on screen at once to be a map rather than a menu you scroll. Identity
        sits at the top where the workspace does, not buried at the bottom.
      */}
      <aside
        className="hidden w-[220px] shrink-0 flex-col overflow-y-auto overscroll-contain p-2 md:flex"
        style={{ background: "var(--yg-surface)", borderRight: "1px solid var(--yg-surface-2)" }}
      >
        <Link
          href="/dashboard"
          className="mb-2 flex items-center gap-2 rounded-[var(--r-control)] p-1.5 transition-colors hover:bg-surface-2"
        >
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-[var(--r-control)] text-[12px] font-semibold"
            style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
            aria-hidden
          >
            Y
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[var(--text-body)] font-medium">Yugaantar &rsquo;26</span>
            <span className="truncate text-[var(--text-meta)] text-text-muted">
              {user.name}
              {user.isSuperAdmin ? " · admin" : ""}
            </span>
          </span>
        </Link>

        <nav className="flex flex-col gap-4">
          {groups.map((group) => (
            <div key={group.label} className="flex flex-col gap-px">
              <p className="meta-label px-2 pb-1">{group.label}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.href}
                  href={item.href}
                  label={item.label}
                  icon={item.icon}
                  hot={item.hot}
                  count={item.badge ? counts[item.badge] : 0}
                />
              ))}
            </div>
          ))}

          <div className="flex flex-col gap-px">
            <p className="meta-label px-2 pb-1">You</p>
            <NavLink href="/notifications" label="Notifications" icon={Bell} count={unread} />
          </div>
        </nav>

        <div className="mt-auto pt-4">
          <p className="px-2 pb-1 text-[var(--text-meta)] text-text-faint">
            {user.departmentName} · {user.role.replace("_", " ").toLowerCase()}
          </p>
          <SignOutButton withClerk={clerkConfigured()} />
        </div>
      </aside>

      {/* --------------------------------------------------------------- main */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* No longer `sticky`: it is a fixed row of a frame that does not move. */}
        <header
          className="shrink-0 md:hidden"
          style={{ background: "var(--yg-surface)", borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <div className="flex items-center justify-between gap-3 px-3 py-2">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span
                className="flex size-6 items-center justify-center rounded-[var(--r-control)] text-[12px] font-semibold"
                style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
                aria-hidden
              >
                Y
              </span>
              <span className="text-[var(--text-body)] font-medium">Yugaantar &rsquo;26</span>
            </Link>
            <Link href="/notifications" className="tap relative text-text-soft" aria-label="Notifications">
              <Bell size={18} aria-hidden />
              {unread > 0 && (
                <span
                  className="absolute top-1.5 right-1.5 size-2 rounded-full"
                  style={{ background: "var(--yg-accent)" }}
                  aria-label={`${unread} unread`}
                />
              )}
            </Link>
          </div>
        </header>

        {/*
          The page's own scroll box. `min-h-0` so a child can instead be a fixed
          two-pane layout that fills the height (chat); `scrollbar-gutter: stable`
          so a page does not jump sideways by a scrollbar's width the moment it
          grows past one screen.
        */}
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 py-5 md:px-7 md:py-8"
          style={{ scrollbarGutter: "stable" }}
        >
          {children}
        </main>

        {/*
          A row of the frame rather than a bar floating over the page. Nothing can
          be buried underneath it now, which is what the 96px of bottom padding on
          every screen was there to prevent.
        */}
        <nav
          className="shrink-0 flex justify-around gap-1 px-2 pt-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
          style={{ background: "var(--yg-surface)", borderTop: "1px solid var(--yg-surface-2)" }}
          aria-label="Primary"
        >
          {tabs.map((tab) => <TabLink key={tab.href} {...tab} />)}
        </nav>
      </div>
    </div>
  );
}
