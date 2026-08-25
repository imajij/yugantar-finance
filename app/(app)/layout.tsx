import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Bell, ClipboardList, FileText, FileDown, Flag, Gauge, HandCoins, ListChecks,
  MessagesSquare, ScrollText, Settings, Ticket, Truck,
} from "lucide-react";
import { getSession, clerkConfigured } from "@/lib/session";
import { can, type Action } from "@/lib/authz";
import { unreadCount } from "@/lib/services/notifications";
import { unreadTotal } from "@/lib/services/chat";
import { SignOutButton } from "@/components/sign-out";

/** Every page here reads the session cookie, so none of them may be prerendered. */
export const dynamic = "force-dynamic";

/** Sidebar entries are filtered by the same `can` the API enforces (18.2 rule 1). */
const NAV: { href: string; label: string; icon: typeof Gauge; action: Action }[] = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge, action: "fest.view" },
  { href: "/requests", label: "Reimbursements", icon: FileText, action: "reimbursement.create" },
  { href: "/tickets", label: "Work tickets", icon: Ticket, action: "ticket.create" },
  { href: "/chat", label: "Channels", icon: MessagesSquare, action: "fest.view" },
  { href: "/budget", label: "Budget", icon: ListChecks, action: "department.budget.view" },
  { href: "/vendors", label: "Vendors", icon: Truck, action: "vendor.view" },
  { href: "/income", label: "Income", icon: HandCoins, action: "income.view" },
  { href: "/queues", label: "Queues", icon: ClipboardList, action: "reimbursement.create" },
  { href: "/flags", label: "Flags", icon: Flag, action: "flag.view" },
  { href: "/close-out", label: "Close-out", icon: FileDown, action: "closeOut.view" },
  { href: "/audit", label: "Audit log", icon: ScrollText, action: "audit.view" },
  { href: "/admin", label: "Admin", icon: Settings, action: "user.manage" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const nav = NAV.filter((n) => can(user, n.action, scope));
  const [unread, unreadMessages] = await Promise.all([unreadCount(user), unreadTotal(user)]);

  const navLinks = (
    <>
      {nav.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-soft hover:bg-surface-2 hover:text-text"
        >
          <Icon size={16} aria-hidden />
          {label}
          {href === "/chat" && unreadMessages > 0 && (
            <span
              className="ml-auto rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
              style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
              aria-label={`${unreadMessages} unread messages`}
            >
              {unreadMessages > 99 ? "99+" : unreadMessages}
            </span>
          )}
        </Link>
      ))}
      <Link
        href="/notifications"
        className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-soft hover:bg-surface-2 hover:text-text"
      >
        <Bell size={16} aria-hidden />
        Notifications
        {unread > 0 && (
          <span
            className="ml-auto rounded-full px-1.5 py-0.5 text-[11px] font-semibold tabular-nums"
            style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
            aria-label={`${unread} unread`}
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Link>
    </>
  );

  return (
    <div className="flex min-h-screen">
      <aside
        className="hidden w-60 shrink-0 flex-col p-4 md:flex"
        style={{ background: "var(--yg-surface)", borderRight: "1px solid var(--yg-surface-2)" }}
      >
        <Link href="/dashboard" className="font-display text-lg text-lime">
          Yugaantar &rsquo;26
        </Link>
        <p className="mt-1 text-xs text-text-muted">Finance &amp; Operations</p>

        <nav className="mt-6 flex flex-col gap-0.5">{navLinks}</nav>

        <div className="mt-auto space-y-2 pt-6 text-xs">
          <div>
            <p className="text-text">{user.name}</p>
            <p className="text-text-muted">
              {user.departmentName} &middot; {user.role.replace("_", " ").toLowerCase()}
            </p>
          </div>
          <SignOutButton withClerk={clerkConfigured()} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-10 md:hidden"
          style={{ background: "var(--yg-surface)", borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <div className="flex items-center justify-between px-4 py-3">
            <Link href="/dashboard" className="font-display text-lime">Yugaantar &rsquo;26</Link>
            <div className="flex items-center gap-3 text-xs">
              <Link href="/notifications" className="relative text-text-soft" aria-label="Notifications">
                <Bell size={18} aria-hidden />
                {unread > 0 && (
                  <span
                    className="absolute -right-1.5 -top-1.5 rounded-full px-1 text-[10px] font-semibold"
                    style={{ background: "var(--yg-lime)", color: "var(--yg-on-accent)" }}
                  >
                    {unread > 9 ? "9+" : unread}
                  </span>
                )}
              </Link>
              <span className="text-text-muted">{user.name}</span>
            </div>
          </div>
          {/* Members submit from phones mid-fest (PRD 14), so the nav has to reach them there. */}
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs whitespace-nowrap text-text-soft"
                style={{ background: "var(--yg-surface-2)" }}
              >
                <Icon size={13} aria-hidden />
                {label}
              </Link>
            ))}
          </nav>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
      </div>
    </div>
  );
}
