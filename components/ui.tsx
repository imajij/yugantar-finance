/**
 * The handful of primitives every screen needs, following PRD 9.1:
 * lime = primary, yellow = the one most important action, pink = secondary and links,
 * semantic palette for states, amounts always tabular and right-aligned.
 */
import type { ReactNode } from "react";
import { chipStyle, flagStyle, stateLabel } from "@/lib/state-chip";
import { formatPaise } from "@/lib/money";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl p-4 ${className}`}
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      {children}
    </div>
  );
}

/** One of the five numbers. Label in Reem Kufi, amount in Source Code Pro (9.1). */
export function StatCard({
  label, paise, tone, hint,
}: { label: string; paise: number; tone?: "waiting" | "decided" | "done" | "neutral"; hint?: string }) {
  const color =
    tone === "waiting" ? "var(--state-waiting-fg)"
    : tone === "decided" ? "var(--state-decided-fg)"
    : tone === "done" ? "var(--state-done-fg)"
    : "var(--yg-text)";
  return (
    <Card>
      <p className="font-display text-xs tracking-wide text-text-muted uppercase">{label}</p>
      <p className="tnum mt-2 text-2xl" style={{ color }}>{formatPaise(paise)}</p>
      {hint && <p className="mt-1 text-xs text-text-muted">{hint}</p>}
    </Card>
  );
}

/** Pill chip with a text label — never colour alone (9.1 rule 3, PRD 14 accessibility). */
export function StateChip({ state }: { state: string }) {
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={chipStyle(state)}>
      {stateLabel(state)}
    </span>
  );
}

export function FlagChip({ severity, children }: { severity: "HIGH" | "MEDIUM" | "LOW"; children: ReactNode }) {
  return (
    <span className="rounded-full px-2.5 py-0.5 text-xs font-medium" style={flagStyle(severity)}>
      {children}
    </span>
  );
}

/** Amounts are right-aligned and tabular wherever they appear in a table (9.1 rule 4). */
export function Amount({ paise, className = "" }: { paise: number; className?: string }) {
  return <span className={`tnum tabular-nums ${className}`}>{formatPaise(paise)}</span>;
}

/**
 * Utilization bar. Over 100% is shown, not clamped — an HOD needs to see the overrun.
 */
export function UtilizationBar({ pct }: { pct: number }) {
  const over = pct > 100;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full" style={{ background: "var(--yg-surface-2)" }}>
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(pct, 100)}%`,
            background: over ? "var(--state-bad-fg)" : "var(--yg-lime)",
          }}
        />
      </div>
      <span className="tnum text-xs" style={{ color: over ? "var(--state-bad-fg)" : "var(--yg-text-muted)" }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

export function PageTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <h1 className="font-display text-2xl">{children}</h1>
      {action}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-lg p-6 text-sm text-text-muted" style={{ background: "var(--yg-surface)" }}>{children}</p>;
}
