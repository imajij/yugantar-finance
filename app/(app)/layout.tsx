import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Bell, ClipboardList, FileText, FileDown, Gauge, HandCoins, ListChecks,
  ScrollText, Settings, Ticket, Truck,
} from "lucide-react";
import { getSession } from "@/lib/session";
import { can, type Action } from "@/lib/authz";

/** Sidebar entries are filtered by the same `can` the API enforces (18.2 rule 1). */
const NAV: { href: string; label: string; icon: typeof Gauge; action: Action }[] = [
  { href: "/dashboard", label: "Dashboard", icon: Gauge, action: "fest.view" },
  { href: "/requests", label: "Reimbursements", icon: FileText, action: "reimbursement.create" },
  { href: "/tickets", label: "Work tickets", icon: Ticket, action: "ticket.create" },
  { href: "/budget", label: "Budget", icon: ListChecks, action: "department.budget.view" },
  { href: "/vendors", label: "Vendors", icon: Truck, action: "vendor.view" },
  { href: "/income", label: "Income", icon: HandCoins, action: "income.view" },
  { href: "/queues", label: "Queues", icon: ClipboardList, action: "reimbursement.create" },
  { href: "/notifications", label: "Notifications", icon: Bell, action: "fest.view" },
  { href: "/close-out", label: "Close-out", icon: FileDown, action: "export.run" },
  { href: "/audit", label: "Audit log", icon: ScrollText, action: "audit.view" },
  { href: "/admin", label: "Admin", icon: Settings, action: "user.manage" },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const scope = { festId: user.festId, departmentId: user.departmentId };
  const nav = NAV.filter((n) => can(user, n.action, scope));

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

        <nav className="mt-6 flex flex-col gap-0.5">
          {nav.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-text-soft hover:bg-surface-2 hover:text-text"
            >
              <Icon size={16} aria-hidden />
              {label}
            </Link>
          ))}
        </nav>

        <div className="mt-auto pt-6 text-xs">
          <p className="text-text">{user.name}</p>
          <p className="text-text-muted">
            {user.departmentName} &middot; {user.role.replace("_", " ").toLowerCase()}
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex items-center justify-between px-6 py-3 md:hidden"
          style={{ background: "var(--yg-surface)", borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <Link href="/dashboard" className="font-display text-lime">Yugaantar &rsquo;26</Link>
          <span className="text-xs text-text-muted">{user.name}</span>
        </header>

        <main className="min-w-0 flex-1 px-6 py-8">{children}</main>
      </div>
    </div>
  );
}
