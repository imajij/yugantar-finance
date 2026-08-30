"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CommentRow {
  id: string;
  body: string;
  author: string;
  createdAt: Date | string;
  editedAt: Date | string | null;
}

/** PRD 7.6 — one thread per entity. @email mentions notify the person named. */
export function CommentThread({
  entityType, entityId, comments,
}: { entityType: string; entityId: string; comments: CommentRow[] }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/comments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entity_type: entityType, entity_id: entityId, body }),
    });
    setBusy(false);
    if (!res.ok) {
      const json = await res.json().catch(() => null);
      setError(json?.error?.message ?? "Could not post that");
      return;
    }
    setBody("");
    router.refresh();
  }

  return (
    <div
      className="mt-4 rounded-xl p-4"
      style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
    >
      <h2 className="font-display text-sm">Discussion</h2>

      {comments.length > 0 && (
        <ol className="mt-3 space-y-3">
          {comments.map((c) => (
            <li key={c.id} className="text-sm">
              <p className="text-text-soft">
                <span className="text-text">{c.author}</span>
                <span className="tnum ml-2 text-xs text-text-muted">
                  {new Date(c.createdAt).toLocaleString("en-IN")}
                </span>
                {c.editedAt && <span className="ml-1 text-xs text-text-muted">(edited)</span>}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap">{c.body}</p>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={post} className="mt-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="Add a note. Type @someone@sst.scaler.com to notify them."
          className="w-full rounded-lg px-3 py-2.5 text-sm"
          style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)", color: "var(--yg-text)" }}
        />
        <button
          type="submit" disabled={busy || !body.trim()}
          className="mt-2 rounded-full px-4 py-2 text-sm font-medium disabled:opacity-50"
          style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
        >
          {busy ? "Posting…" : "Post"}
        </button>
        {error && <p className="mt-2 text-sm" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}
      </form>
    </div>
  );
}
