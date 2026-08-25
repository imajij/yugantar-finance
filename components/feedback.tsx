import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

/**
 * One error, one success, one notice.
 *
 * Before this the app had at least four ways of telling you something went wrong —
 * inline red text under a field, a tinted banner, a paragraph in the flag palette,
 * and a `window.alert` in one place. Whether a message mattered depended on where
 * it happened to appear rather than on what it said.
 *
 * The shape is the same in all three: an icon, a sentence that states the fact, and
 * an optional second line that says what to do about it. The second line is the
 * part worth insisting on — "Tech has already committed or spent ₹3,65,800" tells
 * you why it refused; "lower the figure to ₹3,65,800 or more, or close a line item
 * first" tells you how to proceed, and only one of those is a message.
 */

interface NoteProps {
  children: ReactNode;
  /** What to do next. Optional, and worth writing whenever there is an answer. */
  detail?: ReactNode;
  className?: string;
}

export function ErrorNote({ children, detail, className = "" }: NoteProps) {
  return (
    <Note
      className={className}
      icon={<AlertTriangle size={18} aria-hidden />}
      fg="var(--flag-high-fg)"
      bg="var(--flag-high-bg)"
      border="#6b2c2c"
      detailColour="#e0b8b8"
      detail={detail}
    >
      {children}
    </Note>
  );
}

export function SuccessNote({ children, detail, className = "" }: NoteProps) {
  return (
    <Note
      className={className}
      icon={<CheckCircle2 size={18} aria-hidden />}
      fg="var(--state-done-fg)"
      bg="var(--state-done-bg)"
      border="#2c6b2c"
      detailColour="#b8e0b8"
      detail={detail}
    >
      {children}
    </Note>
  );
}

/** Neither good nor bad — a consequence somebody should know before they act. */
export function InfoNote({ children, detail, className = "" }: NoteProps) {
  return (
    <Note
      className={className}
      icon={<Info size={18} aria-hidden />}
      fg="var(--state-waiting-fg)"
      bg="var(--flag-medium-bg)"
      border="var(--yg-surface-2)"
      detailColour="var(--yg-text-muted)"
      detail={detail}
    >
      {children}
    </Note>
  );
}

function Note({
  children, detail, icon, fg, bg, border, detailColour, className,
}: NoteProps & {
  icon: ReactNode; fg: string; bg: string; border: string; detailColour: string;
}) {
  return (
    <div
      className={`flex items-start gap-3 rounded-[var(--r-card)] p-4 ${className}`}
      style={{ background: bg, border: `1px solid ${border}` }}
      role="status"
    >
      <span className="mt-px shrink-0" style={{ color: fg }}>{icon}</span>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[13.5px] leading-relaxed font-medium">{children}</p>
        {detail && <p className="text-[12.5px] leading-relaxed" style={{ color: detailColour }}>{detail}</p>}
      </div>
    </div>
  );
}
