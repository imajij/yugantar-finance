"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";

/**
 * A row of the sidebar, and the one that knows where you are.
 *
 * The sidebar had no active state at all — every entry looked identical on every
 * screen, so the only way to know which page you were on was to read the heading.
 * That is most of what "hard to navigate" meant: not too few links, no answer to
 * "where am I".
 *
 * Matching is prefix-based on the segment, so `/requests/new` and
 * `/requests/{id}` both light up Reimbursements. Exact matching would go dark the
 * moment you opened anything, which is precisely when you want the map.
 */
export function NavLink({
  href, label, icon: Icon, count = 0, hot = false, onNavigate,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  count?: number;
  /** An amber badge is a queue with your name on it, not a tally. */
  hot?: boolean;
  onNavigate?: () => void;
}) {
  const active = useIsActive(href);
  return (
    <Link href={href} className="nav-item" data-active={active} onClick={onNavigate}>
      <Icon size={16} className="shrink-0" aria-hidden />
      <span className="flex-1 truncate">{label}</span>
      {count > 0 && (
        <span
          className="tnum rounded-[4px] px-1.5 text-[var(--text-meta)] leading-[18px]"
          style={
            hot
              ? { background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }
              : { background: "var(--yg-surface-3)", color: "var(--yg-text-muted)" }
          }
          aria-label={`${count} waiting`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}

/** The bottom bar on a phone. Same question, a shape that suits a thumb. */
export function TabLink({
  href, label, icon: Icon,
}: { href: string; label: string; icon: LucideIcon }) {
  const active = useIsActive(href);
  return (
    <Link
      href={href}
      className="flex min-w-[var(--row-h)] flex-1 flex-col items-center gap-0.5 py-1 text-[10px]"
      style={{ color: active ? "var(--yg-text)" : "var(--yg-text-muted)" }}
      aria-current={active ? "page" : undefined}
    >
      <span
        className="flex h-7 w-11 items-center justify-center rounded-[var(--r-control)]"
        style={{ background: active ? "var(--yg-surface-2)" : "transparent" }}
      >
        <Icon size={18} aria-hidden />
      </span>
      {label}
    </Link>
  );
}

function useIsActive(href: string): boolean {
  const pathname = usePathname() ?? "";
  const [base] = href.split("?");
  if (base === "/dashboard") return pathname === base;   // never the fallback match
  return pathname === base || pathname.startsWith(`${base}/`);
}
