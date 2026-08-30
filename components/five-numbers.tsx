import type { ReactNode } from "react";
import { formatPaise } from "@/lib/money";

/**
 * The five numbers, as one derived figure rather than five sibling boxes.
 *
 * This is the redesign's central idea and it fixes the product's most persistent
 * confusion. Allocated, Pending, Committed and Spent were shown as four cards
 * beside a fifth called Available, which is a lie about what they are: Available is
 * not a peer of the other four, it is what is *left* after them. HODs read five
 * equal boxes, saw a number lower than they expected, and had no way to discover
 * that a request awaiting a decision had already been held back.
 *
 * So the figure is Available, and the other four are drawn as what it was derived
 * from — a segmented bar in spend order and, at the two larger sizes, the
 * arithmetic itself. Pending reads as a deduction because it is drawn as one.
 *
 * Three levels, one component:
 *
 *   A  hero      a fest or a department's own page — the answer to "how much is left"
 *   B  card      one department among several, or the same figure on a phone
 *   C  inline    a line item in a list; the bar alone, no prose
 *
 * The numbers themselves are never computed here. They come from the SQL views
 * (18.2 rule 3) and this only arranges them.
 */

export interface FiveNumbers {
  allocatedPaise: number;
  pendingPaise: number;
  committedPaise: number;
  spentPaise: number;
  availablePaise: number;
}

/** Bar order is spend order: what is gone, what is promised, what is asked for. */
const SEGMENTS = [
  { key: "spent", label: "Spent", note: "paid out", colour: "var(--state-done-fg)" },
  { key: "committed", label: "Committed", note: "approved, not paid", colour: "var(--state-decided-fg)" },
  { key: "pending", label: "Pending", note: "awaiting a decision", colour: "var(--state-waiting-fg)" },
] as const;

const partsOf = (t: FiveNumbers) => [t.spentPaise, t.committedPaise, t.pendingPaise];

/**
 * Available goes amber then red as a department approaches its cap, because by
 * then the number is a warning and not a fact.
 */
export function availableTone(t: FiveNumbers): string {
  if (t.availablePaise <= 0) return "var(--flag-high-fg)";
  const share = t.allocatedPaise > 0 ? t.availablePaise / t.allocatedPaise : 1;
  if (share < 0.08) return "var(--flag-high-fg)";
  if (share < 0.18) return "var(--state-waiting-fg)";
  return "var(--yg-accent)";
}

/**
 * The segmented bar. The tail is dashed rather than filled: what is left is an
 * absence, and drawing it as another colour would make Available look like a fifth
 * kind of spending.
 */
export function DerivationBar({ totals, height = 14 }: { totals: FiveNumbers; height?: number }) {
  const base = Math.max(totals.allocatedPaise, 1);
  const parts = partsOf(totals);
  // An overspent department has segments summing past 100%. Showing the overflow
  // clipped is the honest rendering — the number beside it carries the detail.
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / base) * 100)).toFixed(2)}%`;
  const used = parts.reduce((a, b) => a + b, 0);
  const remainder = Math.max(0, base - used);

  return (
    <div
      className="flex overflow-hidden rounded-full"
      style={{ height, background: "var(--yg-surface-2)", gap: 2 }}
      aria-hidden
    >
      {SEGMENTS.map((s, i) => (
        <div key={s.key} style={{ width: pct(parts[i]), background: s.colour }} />
      ))}
      {remainder > 0 && (
        <div
          style={{
            width: pct(remainder),
            background: "var(--yg-surface-2)",
            border: "1px dashed var(--yg-outline)",
            borderRadius: "0 999px 999px 0",
          }}
        />
      )}
    </div>
  );
}

/** The arithmetic, spelled out. Allocated, then three deductions, then the remainder. */
function Derivation({ totals, columns = 1 }: { totals: FiveNumbers; columns?: 1 | 2 }) {
  const parts = partsOf(totals);
  return (
    <div
      className={columns === 2 ? "grid gap-x-5 gap-y-3 sm:grid-cols-2" : "flex flex-col"}
    >
      <Line
        colour="var(--yg-text)"
        label="Allocated"
        value={formatPaise(totals.allocatedPaise)}
        strong
      />
      {SEGMENTS.map((s, i) => (
        <Line
          key={s.key}
          colour={s.colour}
          label={s.label}
          note={s.note}
          // Drawn as a deduction, because that is what it is.
          value={`− ${formatPaise(parts[i])}`}
        />
      ))}
    </div>
  );
}

function Line({
  colour, label, note, value, strong,
}: {
  colour: string; label: string; note?: string; value: string; strong?: boolean;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 py-2"
      style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colour }} aria-hidden />
        <span className="text-[13px]" style={{ color: strong ? "var(--yg-text)" : "var(--yg-text-soft)" }}>
          {label}
        </span>
        {note && <span className="hidden truncate text-[11.5px] text-text-muted sm:inline">{note}</span>}
      </span>
      <span
        className="tnum shrink-0 text-[13px] sm:text-[14px]"
        style={{ color: strong ? "var(--yg-text)" : "var(--yg-text-soft)" }}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * Level A — the hero. One per screen, and only where the question the page answers
 * *is* "how much is left".
 */
export function AvailableHero({
  label, totals, caption, action, explainPending = true,
}: {
  label: string;
  totals: FiveNumbers;
  caption?: ReactNode;
  action?: ReactNode;
  /** The sentence that stops an HOD wondering where their money went. */
  explainPending?: boolean;
}) {
  return (
    <section
      className="flex min-w-0 flex-col gap-[18px] rounded-[var(--r-shell)] p-5 sm:p-7"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4 min-w-0">
        <div className="flex min-w-0 flex-col gap-2">
          <h2 className="meta-label">{label}</h2>
          {/*
            Fluid, not a breakpoint. A fest total is an eight-figure amount and
            "₹4,98,97,500.00" is fifteen unbreakable tabular glyphs — at a fixed
            34px that is 306px of number inside a 328px phone, and the whole page
            scrolls sideways. `clamp` against the viewport makes the figure fit the
            screen it is on rather than the screen it was designed on.
          */}
          <p
            className="tnum leading-none font-semibold"
            style={{ color: availableTone(totals), fontSize: "clamp(26px, 7.5vw, 44px)" }}
          >
            {formatPaise(totals.availablePaise)}
          </p>
          {caption && <p className="text-[13px] text-text-muted">{caption}</p>}
        </div>
        {action}
      </div>

      <DerivationBar totals={totals} />
      <Derivation totals={totals} columns={2} />

      {explainPending && totals.pendingPaise > 0 && (
        <p
          className="rounded-[12px] px-3.5 py-3 text-[12.5px] leading-relaxed text-text-muted"
          style={{ background: "var(--yg-bg-app)" }}
        >
          Pending is held back from Available — you cannot spend the same rupee twice, so a
          request awaiting a decision already counts against the balance.
        </p>
      )}
    </section>
  );
}

/** Level B — one department among several, or the hero's figure on a small screen. */
export function AvailableCard({
  label, totals, caption, href,
}: {
  label: string;
  totals: FiveNumbers;
  caption?: ReactNode;
  href?: string;
}) {
  const body = (
    <>
      <p className="meta-label">{label}</p>
      <p
        className="tnum leading-none font-semibold"
        style={{ color: availableTone(totals), fontSize: "clamp(20px, 5.5vw, 26px)" }}
      >
        {formatPaise(totals.availablePaise)}
      </p>
      <DerivationBar totals={totals} height={8} />
      {caption && <p className="text-[11.5px] text-text-muted">{caption}</p>}
    </>
  );

  const className = "flex flex-col gap-3 rounded-[var(--r-card)] p-[18px]";
  const style = { background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" };

  return href
    ? <a href={href} className={`${className} hover:border-accent`} style={style}>{body}</a>
    : <div className={className} style={style}>{body}</div>;
}

/**
 * Level C — a line item in a list. No prose and no legend: at this size the bar is
 * a shape you scan down a column, and the number beside it is the answer.
 */
export function AvailableInline({ totals }: { totals: FiveNumbers }) {
  return <DerivationBar totals={totals} height={5} />;
}

/**
 * The four figures as labelled columns, for a screen that has already shown the
 * hero and needs the parts named rather than re-derived.
 */
export function DerivationLegend({ totals }: { totals: FiveNumbers }) {
  const parts = partsOf(totals);
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <Column colour="var(--yg-text)" label="Allocated" value={totals.allocatedPaise} />
      {SEGMENTS.map((s, i) => (
        <Column key={s.key} colour={s.colour} label={s.label} value={parts[i]} />
      ))}
    </div>
  );
}

function Column({ colour, label, value }: { colour: string; label: string; value: number }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 pl-3" style={{ borderLeft: `3px solid ${colour}` }}>
      <span className="text-[11.5px] text-text-muted">{label}</span>
      <span className="tnum text-[13.5px] sm:text-[15px]">{formatPaise(value)}</span>
    </div>
  );
}
