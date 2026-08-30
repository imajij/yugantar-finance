"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Eye, Hash, MessageSquare, Plus, Search, X } from "lucide-react";

/**
 * The channel list.
 *
 * An administrator sees every channel in the fest, and the ones they are not in are
 * marked — both so they know they are looking at somebody else's conversation, and
 * so the list does not quietly imply they belong there.
 */

export interface ChannelSummary {
  id: string;
  kind: "DEPARTMENT" | "DIRECT";
  name: string;
  topic: string | null;
  departmentId: string | null;
  departmentName: string | null;
  isDefault: boolean;
  isMember: boolean;
  archived: boolean;
  unread: number;
  mentions: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  memberCount: number;
}

export interface Person { id: string; name: string; email: string; role: string; department: string }

const FIELD =
  "w-full rounded-[var(--r-control)] px-3.5 py-2.5 text-[13.5px] bg-[var(--yg-bg-app)] "
  + "border border-[var(--yg-surface-2)] text-[var(--yg-text)]";

const message = (b: unknown) =>
  (b as { error?: { message?: string } })?.error?.message ?? "That did not work";

export function ChannelSidebar({
  channels, people, activeId, canCreate, myDepartmentId, myDepartmentName,
}: {
  channels: ChannelSummary[];
  people: Person[];
  activeId?: string;
  canCreate: boolean;
  myDepartmentId: string;
  myDepartmentName: string;
}) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = channels.filter((c) => c.isMember && c.kind === "DEPARTMENT" && !c.archived);
  const dms = channels.filter((c) => c.isMember && c.kind === "DIRECT");
  const others = channels.filter((c) => !c.isMember);

  async function create() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/channels", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ department_id: myDepartmentId, name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return; }
    const created = await res.json();
    setCreating(false);
    setName("");
    router.push(`/chat/${created.id}`);
    router.refresh();
  }

  async function openDirect(userId: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/v1/channels/direct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    setBusy(false);
    if (!res.ok) { setError(message(await res.json().catch(() => null))); return; }
    const channel = await res.json();
    setPicking(false);
    setQ("");
    router.push(`/chat/${channel.id}`);
    router.refresh();
  }

  const matches = people.filter((p) =>
    `${p.name} ${p.email} ${p.department}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <nav className="flex h-full flex-col gap-4 overflow-y-auto p-3">
      {error && <p className="text-xs" style={{ color: "var(--flag-high-fg)" }}>{error}</p>}

      <section>
        <header className="mb-1.5 flex items-center justify-between px-1">
          <h2 className="font-display text-[10px] tracking-[0.18em] text-text-muted uppercase">{myDepartmentName}</h2>
          {canCreate && (
            <button
              type="button"
              onClick={() => setCreating((v) => !v)}
              aria-label="New channel"
              className="rounded p-0.5 text-text-muted hover:text-text"
            >
              {creating ? <X size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
            </button>
          )}
        </header>

        {creating && (
          <div className="mb-2 flex gap-1.5 px-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && name.trim().length > 1) create(); }}
              placeholder="stage-crew"
              className={FIELD}
              aria-label="New channel name"
            />
            <button
              type="button"
              disabled={busy || name.trim().length < 2}
              onClick={create}
              className="rounded-lg px-2.5 text-xs font-medium disabled:opacity-40"
              style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
            >
              Add
            </button>
          </div>
        )}

        <ul className="space-y-0.5">
          {mine.length === 0 && <li className="px-2 py-1 text-xs text-text-muted">No channels yet.</li>}
          {mine.map((c) => <Row key={c.id} channel={c} active={c.id === activeId} />)}
        </ul>
      </section>

      <section>
        <header className="mb-1.5 flex items-center justify-between px-1">
          <h2 className="font-display text-[10px] tracking-[0.18em] text-text-muted uppercase">Direct messages</h2>
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            aria-label="New direct message"
            className="rounded p-0.5 text-text-muted hover:text-text"
          >
            {picking ? <X size={13} aria-hidden /> : <Plus size={13} aria-hidden />}
          </button>
        </header>

        {picking && (
          <div className="mb-2 px-1">
            <div
              className="mb-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5"
              style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
            >
              <Search size={12} className="text-text-muted" aria-hidden />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Find someone"
                className="w-full bg-transparent text-sm outline-none"
                aria-label="Find someone to message"
              />
            </div>
            <ul className="max-h-56 overflow-y-auto">
              {matches.slice(0, 25).map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openDirect(p.id)}
                    className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2 disabled:opacity-40"
                  >
                    {p.name}
                    <span className="block text-[11px] text-text-muted">{p.department}</span>
                  </button>
                </li>
              ))}
              {matches.length === 0 && <li className="px-2 py-1 text-xs text-text-muted">Nobody matches.</li>}
            </ul>
          </div>
        )}

        <ul className="space-y-0.5">
          {dms.length === 0 && !picking && (
            <li className="px-2 py-1 text-xs text-text-muted">No conversations yet.</li>
          )}
          {dms.map((c) => <Row key={c.id} channel={c} active={c.id === activeId} />)}
        </ul>
      </section>

      {others.length > 0 && (
        <section>
          <header className="mb-1.5 flex items-center gap-1.5 px-1">
            <Eye size={12} className="text-text-muted" aria-hidden />
            <h2 className="font-display text-[10px] tracking-[0.18em] text-text-muted uppercase">Oversight</h2>
          </header>
          <p className="mb-1.5 px-2 text-[11px] text-text-muted">
            You are not in these. Opening one is recorded in the audit log.
          </p>
          <ul className="space-y-0.5">
            {others.map((c) => <Row key={c.id} channel={c} active={c.id === activeId} oversight />)}
          </ul>
        </section>
      )}
    </nav>
  );
}

function Row({
  channel, active, oversight,
}: {
  channel: ChannelSummary; active: boolean; oversight?: boolean;
}) {
  const Icon = channel.kind === "DIRECT" ? MessageSquare : Hash;
  return (
    <li>
      <Link
        href={`/chat/${channel.id}`}
        className="flex h-10 items-center gap-2.5 rounded-xl px-2.5 text-[13px]"
        style={
          active
            ? { background: "var(--yg-surface-2)", color: "var(--yg-text)" }
            : { color: oversight ? "var(--yg-text-muted)" : "var(--yg-text-soft)" }
        }
      >
        <Icon size={13} className="shrink-0 opacity-70" aria-hidden />
        <span className={`min-w-0 flex-1 truncate ${channel.unread > 0 && !oversight ? "font-medium" : ""}`}>
          {channel.name}
          {oversight && channel.departmentName && (
            <span className="ml-1.5 text-[11px] opacity-60">{channel.departmentName}</span>
          )}
        </span>
        {channel.mentions > 0 ? (
          <span
            className="tnum rounded-full px-1.5 text-[11px] font-semibold"
            style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
          >
            {channel.mentions}
          </span>
        ) : channel.unread > 0 && !oversight ? (
          <span
            className="tnum rounded-full px-1.5 text-[11px] font-semibold"
            style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
          >
            {channel.unread > 99 ? "99+" : channel.unread}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

/** Keeps the sidebar's unread counts moving without a page interaction. */
export function usePoll(fn: () => void, ms: number) {
  useEffect(() => {
    // Only while the tab is actually being looked at — a background tab polling
    // every few seconds is a battery and a database bill for nothing.
    const tick = () => { if (document.visibilityState === "visible") fn(); };
    const id = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", tick); };
  }, [fn, ms]);
}
