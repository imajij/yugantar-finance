/**
 * The handful of primitives every screen needs, following PRD 9.1:
 * lime = primary, yellow = the one most important action, pink = secondary and links,
 * semantic palette for states, amounts always tabular and right-aligned.
 *
 * The redesign changes their structure, not their meaning: one density scale (rows
 * 44px, cards 28px inside, sections 24px apart), three container radii, and a 44px
 * floor under anything you tap. Which state is which colour is untouched — that
 * mapping appears in exports and in an audit, and it is not a styling decision.
 */
import type { ComponentProps, ReactNode } from "react";
import { chipStyle, flagStyle, stateLabel } from "@/lib/state-chip";
import { formatPaise } from "@/lib/money";

export function Card({
  children, className = "", tight,
}: {
  children: ReactNode;
  className?: string;
  /** For a card inside another card, where the outer one already gave it air. */
  tight?: boolean;
}) {
  return (
    <div
      className={`rounded-[var(--r-shell)] ${tight ? "p-[18px]" : "p-5 sm:p-[var(--pad-card)]"} ${className}`}
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      {children}
    </div>
  );
}

/** A section heading inside a page. 20px Reem Kufi, with an optional count beside it. */
export function SectionHeading({
  children, aside,
}: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="font-display text-[var(--text-heading)]">{children}</h2>
      {aside}
    </div>
  );
}

/**
 * Buttons. Three tones, one height.
 *
 * `primary` is lime and belongs to the ordinary main action. `hero` is yellow and
 * is the single most important action on a screen — if two things on one screen are
 * yellow, one of them is wrong (9.1 rule 2). `ghost` is everything else.
 */
type Tone = "hero" | "primary" | "ghost" | "destructive";

const TONES: Record<Tone, { background: string; color: string; border?: string }> = {
  hero: { background: "var(--yg-yellow)", color: "var(--yg-on-accent)" },
  primary: { background: "var(--yg-lime)", color: "var(--yg-on-accent)" },
  destructive: { background: "var(--flag-high-fg)", color: "var(--yg-on-accent)" },
  ghost: { background: "transparent", color: "var(--yg-text-soft)", border: "1px solid var(--yg-surface-2)" },
};

export function Button({
  tone = "ghost", className = "", children, ...rest
}: ComponentProps<"button"> & { tone?: Tone }) {
  const t = TONES[tone];
  return (
    <button
      {...rest}
      className={`flex h-[var(--row-h)] items-center justify-center gap-2 rounded-full px-5 text-[13.5px] disabled:opacity-40 ${tone === "ghost" ? "" : "font-bold"} ${className}`}
      style={{ background: t.background, color: t.color, border: t.border }}
    >
      {children}
    </button>
  );
}

/** The same, as a link. Next's `Link` wraps it at the call site. */
export function buttonClass(tone: Tone = "ghost"): string {
  return `inline-flex h-[var(--row-h)] items-center justify-center gap-2 rounded-full px-5 text-[13.5px] ${tone === "ghost" ? "" : "font-bold"}`;
}

export function buttonStyle(tone: Tone = "ghost"): React.CSSProperties {
  return TONES[tone];
}

/**
 * An icon-only control. 44×44 around a 16px glyph — the tap-target floor, because
 * fest week happens on phones, one-handed, at night.
 */
export function IconButton({
  label, children, className = "", ...rest
}: ComponentProps<"button"> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`tap shrink-0 text-text-muted hover:text-text disabled:opacity-40 ${className}`}
      style={{ border: "1px solid var(--yg-surface-2)" }}
    >
      {children}
    </button>
  );
}

/**
 * One figure with a label. Kept for the amounts that are not part of a derivation —
 * a fest total, a vendor's outstanding balance. The five numbers themselves are not
 * this: they are `components/five-numbers.tsx`, which draws them as one derived
 * figure rather than five sibling boxes.
 */
export function StatCard({
  label, paise, tone, hint,
}: { label: string; paise: number; tone?: "waiting" | "decided" | "done" | "neutral"; hint?: string }) {
  const color =
    tone === "waiting" ? "var(--state-waiting-fg)"
    : tone === "decided" ? "var(--state-decided-fg)"
    : tone === "done" ? "var(--state-done-fg)"
    : "var(--yg-text)";
  return (
    <Card tight>
      <p className="meta-label">{label}</p>
      <p className="tnum mt-2.5 text-[26px] leading-none font-semibold" style={{ color }}>
        {formatPaise(paise)}
      </p>
      {hint && <p className="mt-2 text-[12px] text-text-muted">{hint}</p>}
    </Card>
  );
}

/**
 * Pill chip with a text label — never colour alone (9.1 rule 3, PRD 14).
 *
 * The dot is not decoration. On a cheap phone screen at night, two of these tints
 * are close enough to confuse at a glance; a saturated dot at full opacity carries
 * the state even when the tint does not.
 */
export function StateChip({ state }: { state: string }) {
  const style = chipStyle(state);
  return (
    <span
      className="inline-flex items-center gap-[7px] rounded-full py-[5px] pr-3 pl-2.5 text-[12px] font-medium"
      style={style}
    >
      <span className="size-[7px] shrink-0 rounded-full" style={{ background: style.color }} aria-hidden />
      {stateLabel(state)}
    </span>
  );
}

export function FlagChip({ severity, children }: { severity: "HIGH" | "MEDIUM" | "LOW"; children: ReactNode }) {
  const style = flagStyle(severity);
  return (
    <span
      className="inline-flex items-center gap-[7px] rounded-full py-[5px] pr-3 pl-2.5 text-[12px] font-medium"
      style={style}
    >
      <span className="size-[7px] shrink-0 rounded-full" style={{ background: style.color }} aria-hidden />
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

/**
 * The page's own heading. A subtitle is worth writing whenever the page can say
 * what is on it in a phrase — "Six departments · ₹18,40,000 allocated · two
 * allocation requests waiting" answers more than "Budget" does.
 */
export function PageTitle({
  children, subtitle, action,
}: { children: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-[var(--gap-section)] flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1 className="font-display text-[26px] leading-tight sm:text-[var(--text-title)]">{children}</h1>
        {subtitle && <p className="text-[13.5px] text-text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2.5">{action}</div>}
    </div>
  );
}

/**
 * An empty state that says what the thing is for and what to do next.
 *
 * A fest on its first day is *entirely* empty states, and that is a new Finance
 * HOD's first impression of the product. One line of grey text was not an answer to
 * "what is this screen and why is nothing here".
 */
export function Empty({
  icon, title, children, action,
}: {
  icon?: ReactNode;
  title?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 rounded-[var(--r-card)] px-6 py-8 text-center"
      style={{ background: "var(--yg-bg-app)", border: "1px dashed var(--yg-surface-2)" }}
    >
      {icon && (
        <span
          className="flex size-14 items-center justify-center rounded-full"
          style={{ background: "var(--yg-surface-2)", color: "var(--yg-lime)" }}
        >
          {icon}
        </span>
      )}
      {title && <p className="font-display text-[17px]">{title}</p>}
      <div className="max-w-[42ch] text-[13px] leading-relaxed text-text-muted">{children}</div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
