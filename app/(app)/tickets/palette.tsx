"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, Search } from "lucide-react";

/**
 * The command palette.
 *
 * Everything the board can do is already reachable by clicking, and on a board with
 * two hundred tickets clicking is the slow path. `Cmd+K` is the fast one: type
 * three letters of what you want and press Enter. It is the single most
 * characteristic thing about working in Linear, and it is not decoration — it is
 * what makes a keyboard-first board worth having.
 *
 * The list is built by the caller from what is actually available *right now*:
 * with rows selected it offers actions on them, with none it offers navigation and
 * filters. A palette that offers you things you cannot do is a menu.
 */

export interface Command {
  id: string;
  label: string;
  /** The group it appears under; also what a reader scans for. */
  group: string;
  /** Shown right-aligned — a shortcut, a current value, a count. */
  hint?: string;
  /** Rendered before the label; a colour swatch, an icon. */
  icon?: ReactNode;
  run: () => void;
}

/** Subsequence match, the way every palette does it: "sip" finds "Set priority". */
function score(needle: string, haystack: string): number {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  if (h.includes(n)) return 100 - h.indexOf(n);

  let i = 0;
  let hits = 0;
  for (const ch of h) {
    if (ch === n[i]) { i += 1; hits += 1; }
    if (i === n.length) break;
  }
  return i === n.length ? hits : 0;
}

export function CommandPalette({
  open, commands, onClose, placeholder = "Type a command…",
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
  placeholder?: string;
}) {
  if (!open) return null;
  return <Palette commands={commands} onClose={onClose} placeholder={placeholder} />;
}

function Palette({
  commands, onClose, placeholder,
}: {
  commands: Command[]; onClose: () => void; placeholder: string;
}) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // Group headings are worked out here rather than while rendering: a running
  // variable mutated during render is the kind of thing that survives until the
  // first time React renders the list twice.
  const matches = useMemo(() => {
    const scored = commands
      .map((c) => ({ c, s: score(query, `${c.group} ${c.label}`) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.c);
    return scored.map((c, i) => ({ c, head: c.group !== scored[i - 1]?.group ? c.group : null }));
  }, [commands, query]);

  const current = matches[Math.min(at, matches.length - 1)]?.c;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey)) {
        e.preventDefault();
        setAt((i) => Math.min(i + 1, matches.length - 1));
      }
      if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey)) {
        e.preventDefault();
        setAt((i) => Math.max(i - 1, 0));
      }
      if (e.key === "Enter" && current) { e.preventDefault(); onClose(); current.run(); }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [matches.length, current, onClose]);

  useEffect(() => {
    listRef.current?.querySelector('[data-at="true"]')?.scrollIntoView({ block: "nearest" });
  }, [at, matches]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]"
      style={{ background: "rgba(6,6,31,0.72)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-[var(--r-shell)]"
        style={{
          background: "var(--yg-bg-app)",
          border: "1px solid var(--yg-surface-2)",
          boxShadow: "0 24px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div
          className="flex items-center gap-3 px-4"
          style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <Search size={16} className="shrink-0 text-text-muted" aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setAt(0); }}
            placeholder={placeholder}
            aria-label="Command"
            className="h-14 w-full bg-transparent text-[15px] outline-none"
          />
          <kbd
            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-muted"
            style={{ background: "var(--yg-surface-2)" }}
          >
            esc
          </kbd>
        </div>

        <ul ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5">
          {matches.length === 0 && (
            <li className="px-4 py-6 text-center text-[13px] text-text-muted">
              Nothing matches &ldquo;{query}&rdquo;.
            </li>
          )}
          {matches.map(({ c, head }, i) => {
            const active = c === current;
            return (
              <li key={c.id}>
                {head && <p className="meta-label px-4 pt-3 pb-1.5">{head}</p>}
                <button
                  type="button"
                  data-at={active}
                  onMouseEnter={() => setAt(i)}
                  onClick={() => { onClose(); c.run(); }}
                  className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[13.5px]"
                  style={active ? { background: "var(--yg-surface-2)" } : undefined}
                >
                  {c.icon && <span className="flex w-4 shrink-0 justify-center">{c.icon}</span>}
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-[11.5px] text-text-muted">{c.hint}</span>}
                  {active && <CornerDownLeft size={13} className="shrink-0 text-text-muted" aria-hidden />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
