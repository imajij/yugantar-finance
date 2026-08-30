/**
 * The handful of primitives every screen needs.
 *
 * Emphasis used to be carried by hue — lime for primary, yellow for the one most
 * important action, pink for secondary — which meant three saturated colours
 * competing on every screen and none of them meaning anything. It is carried by
 * *fill* now: solid accent for the one action a screen exists for, a quiet filled
 * surface for ordinary ones, and a bare outline for everything else. One accent,
 * used rarely enough that it still reads as emphasis when it appears.
 *
 * Which state is which colour is untouched — that mapping appears in exports and in
 * an audit, and it is not a styling decision.
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
      className={`rounded-[var(--r-shell)] ${tight ? "p-3" : "p-4 sm:p-[var(--pad-card)]"} ${className}`}
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      {children}
    </div>
  );
}

/** A section heading inside a page. Barely larger than body; the weight does the work. */
export function SectionHeading({
  children, aside,
}: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-[var(--text-heading)] font-medium">{children}</h2>
      {aside}
    </div>
  );
}

/**
 * Buttons. Four tones, one height, one radius.
 *
 * The hierarchy is fill, not hue. `hero` is the single action a screen exists for
 * and is the only solid accent on it — if two things on one screen are solid
 * accent, one of them is wrong. `primary` is an ordinary main action and sits on a
 * quiet filled surface. `ghost` is an outline. `destructive` is the one place a
 * second colour is allowed, because "delete" should not look like "save".
 */
type Tone = "hero" | "primary" | "ghost" | "destructive";

const TONES: Record<Tone, { background: string; color: string; border: string }> = {
  hero: { background: "var(--yg-accent)", color: "var(--yg-on-accent)", border: "1px solid var(--yg-accent)" },
  primary: { background: "var(--yg-surface-2)", color: "var(--yg-text)", border: "1px solid var(--yg-surface-3)" },
  destructive: { background: "transparent", color: "var(--flag-high-fg)", border: "1px solid var(--flag-high-bg)" },
  ghost: { background: "transparent", color: "var(--yg-text-soft)", border: "1px solid var(--yg-surface-2)" },
};

const SHAPE =
  "h-[var(--row-h)] items-center justify-center gap-1.5 rounded-[var(--r-control)] "
  + "px-3 text-[var(--text-body)] font-medium transition-colors";

export function Button({
  tone = "ghost", className = "", children, ...rest
}: ComponentProps<"button"> & { tone?: Tone }) {
  const t = TONES[tone];
  return (
    <button
      {...rest}
      className={`flex ${SHAPE} disabled:opacity-40 ${className}`}
      style={{ background: t.background, color: t.color, border: t.border }}
    >
      {children}
    </button>
  );
}

/**
 * The same, as a link. Next's `Link` wraps it at the call site.
 *
 * No tone: every button is the same shape now, and only `buttonStyle` differs.
 * That is the point of moving emphasis from hue to fill.
 */
export function buttonClass(): string {
  return `inline-flex ${SHAPE}`;
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
      className={`tap shrink-0 text-text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-40 ${className}`}
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
      <p className="tnum mt-1.5 text-[20px] leading-none font-medium" style={{ color }}>
        {formatPaise(paise)}
      </p>
      {hint && <p className="mt-1.5 text-[var(--text-support)] text-text-muted">{hint}</p>}
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
      className="inline-flex items-center gap-1.5 rounded-[var(--r-control)] px-1.5 py-0.5 text-[var(--text-meta)] font-medium"
      style={style}
    >
      <span className="size-[6px] shrink-0 rounded-full" style={{ background: style.color }} aria-hidden />
      {stateLabel(state)}
    </span>
  );
}

export function FlagChip({ severity, children }: { severity: "HIGH" | "MEDIUM" | "LOW"; children: ReactNode }) {
  const style = flagStyle(severity);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[var(--r-control)] px-1.5 py-0.5 text-[var(--text-meta)] font-medium"
      style={style}
    >
      <span className="size-[6px] shrink-0 rounded-full" style={{ background: style.color }} aria-hidden />
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
            background: over ? "var(--state-bad-fg)" : "var(--yg-accent)",
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
    <div className="mb-[var(--gap-section)] flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="text-[var(--text-title)] leading-tight font-semibold">{children}</h1>
        {subtitle && <p className="text-[var(--text-support)] text-text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
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
      className="flex flex-col items-center gap-2.5 rounded-[var(--r-card)] px-6 py-10 text-center"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      {icon && (
        <span
          className="flex size-10 items-center justify-center rounded-[var(--r-card)]"
          style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-muted)" }}
        >
          {icon}
        </span>
      )}
      {title && <p className="text-[var(--text-heading)] font-medium">{title}</p>}
      <div className="max-w-[42ch] text-[13px] leading-relaxed text-text-muted">{children}</div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
