"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";

/**
 * Confirm, with a reason. One component, a dozen places.
 *
 * It replaces `window.prompt`, which is what rejecting a claim, blocking a ticket,
 * closing a line item and retiring a vendor all used to open — an unstyled browser
 * dialog, for text that goes into an append-only audit log and stays there. The gap
 * between what the app says about the permanence of a written reason and the way it
 * asked for one was the widest in the product.
 *
 * What it does that a prompt cannot:
 *
 *   - **States the consequence** before the action, in the words of the thing that
 *     is about to happen ("releases the amount back to Tech's available balance and
 *     notifies Aarav") rather than "Are you sure?".
 *   - **Says where the reason goes.** It is written to the audit log against your
 *     name and cannot be edited afterwards. People write differently when they know.
 *   - **Will not enable the action before there is one**, so a required reason is
 *     required in the interface and not only in the API's error message.
 */

export interface ConfirmProps {
  open: boolean;
  title: string;
  /** What will happen, in plain words. Shown above the field. */
  consequence: ReactNode;
  /** Label on the confirming button. */
  confirmLabel: string;
  /** Label on the way out — phrased as the thing that stays true, not "Cancel". */
  cancelLabel?: string;
  /** A destructive action is toned red; an ordinary one takes the accent. */
  tone?: "default" | "destructive";
  /** Omit to confirm without a reason — rare, and the lock line disappears with it. */
  reason?: { label: string; placeholder?: string; minLength?: number; maxLength?: number };
  busy?: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/**
 * Mounted only while open, so the reason field starts empty every time without an
 * effect resetting it — a dialog that remembers what you typed the last time you
 * backed out of it is a way to file the wrong reason against the wrong record.
 */
export function ConfirmWithReason(props: ConfirmProps) {
  if (!props.open) return null;
  return <Dialog {...props} />;
}

function Dialog({
  title, consequence, confirmLabel, cancelLabel = "Cancel",
  tone = "default", reason, busy, error, onConfirm, onCancel,
}: ConfirmProps) {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  const min = reason?.minLength ?? 3;
  const max = reason?.maxLength ?? 400;
  const ready = !reason || text.trim().length >= min;

  useEffect(() => {
    // Focus the field, or the panel when there is nothing to type — either way the
    // keyboard lands inside the dialog rather than behind it.
    const t = setTimeout(() => (reason ? field.current : panel.current)?.focus(), 30);
    return () => clearTimeout(t);
  }, [reason]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      // Enter alone belongs to the textarea — a reason is often two lines.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready && !busy) onConfirm(text.trim());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, busy, text, onConfirm, onCancel]);

  const confirmBg = tone === "destructive" ? "var(--flag-high-fg)" : "var(--yg-accent)";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6"
      style={{ background: "rgba(6,6,31,0.72)" }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        className="flex w-full max-w-lg flex-col gap-[18px] p-6 outline-none sm:rounded-[var(--r-shell)]"
        style={{
          background: "var(--yg-bg-app)",
          border: "1px solid var(--yg-surface-2)",
          borderRadius: "var(--r-shell) var(--r-shell) 0 0",
          boxShadow: "0 24px 48px rgba(0,0,0,0.45)",
        }}
      >
        <div className="flex flex-col gap-2">
          <h2 className="font-display text-[20px]">{title}</h2>
          <div className="text-[13.5px] leading-relaxed text-text-soft">{consequence}</div>
        </div>

        {reason && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="confirm-reason" className="text-[12.5px]">
                {reason.label}{" "}
                <span style={{ color: "var(--yg-accent)" }}>— required, permanent</span>
              </label>
              <span className="tnum text-[11px] text-text-muted">{text.length} / {max}</span>
            </div>
            <textarea
              id="confirm-reason"
              ref={field}
              rows={3}
              value={text}
              maxLength={max}
              onChange={(e) => setText(e.target.value)}
              placeholder={reason.placeholder}
              className="min-h-[86px] rounded-[var(--r-control)] px-4 py-3.5 text-[13.5px] leading-relaxed outline-none"
              style={{
                background: "var(--yg-surface)",
                border: `1px solid ${text.trim().length >= min ? "var(--yg-surface-2)" : "var(--yg-accent)"}`,
                color: "var(--yg-text)",
              }}
            />
            <p className="flex items-center gap-2 text-[12px] text-text-muted">
              <Lock size={13} aria-hidden />
              Written to the audit log against your name. It cannot be edited afterwards.
            </p>
          </div>
        )}

        {error && (
          <p
            className="rounded-[var(--r-control)] px-4 py-3 text-[13px]"
            style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}
            role="status"
          >
            {error}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="h-[var(--row-h)] rounded-full px-5 text-[14px]"
            style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={!ready || busy}
            onClick={() => onConfirm(text.trim())}
            className="flex h-[var(--row-h)] items-center gap-2.5 rounded-full px-[22px] text-[14px] font-bold disabled:opacity-40"
            style={{ background: confirmBg, color: "var(--yg-on-accent)" }}
          >
            {busy && <Spinner />}
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The pending state a button holds while the row it belongs to dims. */
export function Spinner({ size = 15 }: { size?: number }) {
  return (
    <span
      className="yg-spin inline-block rounded-full"
      style={{
        width: size,
        height: size,
        border: "2px solid rgba(6,6,31,0.3)",
        borderTopColor: "currentColor",
      }}
      aria-hidden
    />
  );
}
