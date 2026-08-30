"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Eye, Hash, MessageSquare, Paperclip, Send, Trash2, X } from "lucide-react";
import { chipStyle, stateLabel } from "@/lib/state-chip";
import { ConfirmWithReason } from "@/components/confirm";
import { usePoll } from "../sidebar";

/**
 * One channel.
 *
 * New messages arrive by polling rather than a socket. Vercel's functions are not
 * long-lived and there is no shared broker here, so a WebSocket would be a
 * long-poll wearing a costume — this is the honest version of the same latency.
 * It polls only while the tab is visible, and asks only for messages newer than the
 * last one it has, so a quiet channel costs one cheap query every few seconds.
 */

const POLL_MS = 4000;

export interface MessageAttachment {
  id: string; fileName: string | null; mimeType: string | null; sizeBytes: number | null;
}
export interface MessageLink {
  type: string; id: string; humanId: string | null; label: string; status: string | null;
}
export interface Message {
  id: string;
  body: string;
  authorId: string;
  author: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  parentId: string | null;
  replyCount: number;
  lastReplyAt: string | null;
  attachments: MessageAttachment[];
  links: MessageLink[];
  mentionsMe: boolean;
}

export interface LinkOption { type: string; id: string; label: string; hint: string }

const HREF: Record<string, (id: string) => string> = {
  REIMBURSEMENT: (id) => `/requests/${id}`,
  VENDOR_REQUEST: (id) => `/vendors/requests/${id}`,
  TICKET: (id) => `/tickets/${id}`,
  VENDOR: (id) => `/vendors/${id}`,
};

const errorOf = (b: unknown) =>
  (b as { error?: { message?: string } })?.error?.message ?? "That did not work";

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" });

export function Conversation({
  channel, initial, me, linkOptions,
}: {
  channel: {
    id: string;
    kind: "DEPARTMENT" | "DIRECT";
    displayName: string;
    topic: string | null;
    isMember: boolean;
    isOversight: boolean;
    archived: boolean;
    members: { id: string; name: string; email: string; role: string }[];
    administratorsCanRead: boolean;
  };
  initial: Message[];
  me: { id: string; name: string };
  linkOptions: LinkOption[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>(initial);
  const [thread, setThread] = useState<{ id: string; replies: Message[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const newest = messages.length ? messages[messages.length - 1].createdAt : null;

  const poll = useCallback(async () => {
    const url = new URL(`/api/v1/channels/${channel.id}/messages`, window.location.origin);
    if (newest) url.searchParams.set("after", new Date(newest).toISOString());
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return;
    const { data } = (await res.json()) as { data: Message[] };
    if (data.length === 0) return;

    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...data.filter((m) => !seen.has(m.id))];
    });
    // Only a member has a read marker to move; an oversight read never moves one.
    if (channel.isMember) {
      await fetch(`/api/v1/channels/${channel.id}/read`, { method: "POST" });
      router.refresh();
    }
  }, [channel.id, channel.isMember, newest, router]);

  usePoll(poll, POLL_MS);

  useEffect(() => {
    if (stick.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // "Near enough the bottom" rather than exactly, or a new message while you are
    // reading two screens up yanks you away mid-sentence.
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  /**
   * Opening a thread is a click, so its replies are fetched here rather than in an
   * effect on the panel: the panel opens with the conversation already in it
   * instead of appearing empty and filling in a moment later.
   */
  const openThread = useCallback(async (id: string) => {
    setThread({ id, replies: [] });
    const res = await fetch(
      `/api/v1/channels/${channel.id}/messages?parent_id=${id}`, { cache: "no-store" });
    if (!res.ok) { setError("That thread could not be loaded"); return; }
    const { data } = (await res.json()) as { data: Message[] };
    setThread((t) => (t?.id === id ? { id, replies: data } : t));
  }, [channel.id]);

  const parent = thread ? messages.find((m) => m.id === thread.id) ?? null : null;

  return (
    <div className="relative flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="shrink-0 px-5 py-4"
          style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
        >
          <div className="flex flex-wrap items-center gap-2">
            {/* The only way back to the channel list on a phone: the sidebar is
                `md:block`, so without this you land in one channel and stay there. */}
            <Link href="/chat?list=1" className="tap -ml-2 shrink-0 text-text-muted md:hidden" aria-label="All channels">
              <ArrowLeft size={18} aria-hidden />
            </Link>
            {channel.kind === "DIRECT"
              ? <MessageSquare size={15} className="text-text-muted" aria-hidden />
              : <Hash size={15} className="text-text-muted" aria-hidden />}
            <h1 className="font-display text-[18px]">{channel.displayName}</h1>
            <span className="text-xs text-text-muted">
              {channel.members.length} {channel.members.length === 1 ? "person" : "people"}
            </span>
            {channel.archived && (
              <span className="rounded-full px-2 py-0.5 text-[11px]"
                style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-muted)" }}>
                archived
              </span>
            )}
          </div>
          {channel.topic && <p className="mt-0.5 text-xs text-text-muted">{channel.topic}</p>}

          {/*
            Said out loud, to everyone in the channel — not tucked into a settings
            page and not shown only to the administrator. People will assume a
            department channel is private to the department; this is the sentence
            that stops them being wrong about it later.
          */}
          <p className="mt-1.5 flex items-center gap-2 text-[12px]" style={{ color: "var(--yg-info)" }}>
            <Eye size={14} aria-hidden />
            Administrators can read this channel. Every time one opens a channel they
            are not in, it is recorded in the audit log.
          </p>

          {channel.isOversight && (
            <p
              className="mt-2 rounded-lg px-3 py-2 text-xs"
              style={{ background: "var(--flag-medium-bg)", color: "var(--flag-medium-fg)" }}
            >
              You are reading a channel you are not a member of. This visit is in the audit
              log. You cannot post here without joining, which would put your name in the
              member list.
            </p>
          )}
        </header>

        {error && (
          <p
            className="mx-4 mt-3 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm"
            style={{ background: "var(--flag-high-bg)", color: "var(--flag-high-fg)" }}
            role="status"
          >
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
              <X size={13} aria-hidden />
            </button>
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" onScroll={onScroll}>
          {messages.length === 0 && (
            <p className="py-10 text-center text-sm text-text-muted">
              Nothing here yet. {channel.isMember ? "Say something." : ""}
            </p>
          )}
          {messages.map((m, i) => (
            <MessageRow
              key={m.id}
              message={m}
              previous={messages[i - 1]}
              me={me}
              onReply={() => openThread(m.id)}
              onError={setError}
              onRemoved={() => setMessages((prev) => prev.map((x) =>
                x.id === m.id ? { ...x, deleted: true, body: "", attachments: [], links: [] } : x))}
            />
          ))}
          <div ref={bottom} />
        </div>

        {channel.isMember && !channel.archived ? (
          <Composer
            channelId={channel.id}
            linkOptions={linkOptions}
            members={channel.members}
            onPosted={(m) => { stick.current = true; setMessages((prev) => [...prev, m]); }}
            onError={setError}
          />
        ) : (
          <p
            className="shrink-0 px-4 py-3 text-xs text-text-muted"
            style={{ borderTop: "1px solid var(--yg-surface-2)" }}
          >
            {channel.archived
              ? "This channel is archived. What was said stays readable."
              : "You are not a member of this channel, so you cannot post in it."}
          </p>
        )}
      </div>

      {parent && (
        <Thread
          // Remount per thread: the panel seeds its replies from the props it was
          // opened with, so switching threads has to start it over.
          key={parent.id}
          channelId={channel.id}
          parent={parent}
          initialReplies={thread!.replies}
          me={me}
          canPost={channel.isMember && !channel.archived}
          linkOptions={linkOptions}
          members={channel.members}
          onClose={() => setThread(null)}
          onError={setError}
          onReplied={() => setMessages((prev) => prev.map((x) =>
            x.id === parent.id ? { ...x, replyCount: x.replyCount + 1 } : x))}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ one message */

function MessageRow({
  message: m, previous, me, onReply, onError, onRemoved,
}: {
  message: Message;
  previous?: Message;
  me: { id: string; name: string };
  onReply?: () => void;
  onError: (s: string) => void;
  onRemoved: () => void;
}) {
  // Consecutive messages from one person in a short window read as one turn.
  const grouped = previous
    && previous.authorId === m.authorId
    && !previous.deleted
    && new Date(m.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60 * 1000;

  const newDay = !previous || day(previous.createdAt) !== day(m.createdAt);

  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);

  async function remove() {
    setRemoving(true);
    const res = await fetch(`/api/v1/messages/${m.id}`, { method: "DELETE" });
    setRemoving(false);
    if (!res.ok) { onError(errorOf(await res.json().catch(() => null))); return; }
    setConfirming(false);
    onRemoved();
  }

  return (
    <>
      {newDay && (
        <div className="my-3 flex items-center gap-3">
          <span className="h-px flex-1" style={{ background: "var(--yg-surface-2)" }} />
          <span className="text-[11px] text-text-muted">{day(m.createdAt)}</span>
          <span className="h-px flex-1" style={{ background: "var(--yg-surface-2)" }} />
        </div>
      )}

      <div
        className={`group rounded-lg px-2 ${grouped ? "py-0.5" : "mt-3 py-1"}`}
        style={m.mentionsMe ? { background: "var(--state-waiting-bg)" } : undefined}
      >
        {!grouped && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{m.author}</span>
            <span className="text-[11px] text-text-muted">{time(m.createdAt)}</span>
            {m.editedAt && <span className="text-[11px] text-text-muted">(edited)</span>}
          </div>
        )}

        {m.deleted ? (
          <p className="text-sm text-text-muted italic">This message was removed.</p>
        ) : (
          <>
            {m.body && <p className="text-sm whitespace-pre-wrap text-text-soft">{m.body}</p>}

            {m.attachments.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {m.attachments.map((a) => (
                  <li key={a.id}>
                    <a
                      href={`/api/v1/attachments/${a.id}/url?redirect=1`}
                      className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                      style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
                    >
                      <Paperclip size={11} aria-hidden />
                      {a.fileName ?? "file"}
                      {a.sizeBytes ? <span className="tnum opacity-60">{Math.round(a.sizeBytes / 1024)}KB</span> : null}
                    </a>
                  </li>
                ))}
              </ul>
            )}

            {m.links.length > 0 && (
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {m.links.map((l) => {
                  const href = l.humanId ? HREF[l.type]?.(l.id) : undefined;
                  const inner = (
                    <span className="flex items-center gap-1.5">
                      <span className="tnum text-xs">{l.label}</span>
                      {l.status && (
                        <span className="rounded-full px-1.5 text-[10px]" style={chipStyle(l.status)}>
                          {stateLabel(l.status)}
                        </span>
                      )}
                    </span>
                  );
                  return (
                    <li key={`${l.type}:${l.id}`}>
                      {href ? (
                        <Link
                          href={href}
                          className="block rounded-lg px-2 py-1"
                          style={{ border: "1px solid var(--yg-surface-2)", color: "var(--yg-accent)" }}
                        >
                          {inner}
                        </Link>
                      ) : (
                        // A link is never a way to read something you could not open.
                        <span
                          className="block rounded-lg px-2 py-1 text-text-muted"
                          style={{ border: "1px dashed var(--yg-surface-2)" }}
                        >
                          {inner}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        <div className="mt-0.5 flex items-center gap-3 text-[11px] opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          {onReply && !m.deleted && (
            <button type="button" onClick={onReply} className="text-text-muted hover:text-text">
              Reply
            </button>
          )}
          {!m.deleted && m.authorId === me.id && (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="flex items-center gap-1 text-text-muted hover:text-text"
            >
              <Trash2 size={10} aria-hidden /> Remove
            </button>
          )}
        </div>

        <ConfirmWithReason
          open={confirming}
          title="Remove this message?"
          consequence={
            <>It keeps its place in the conversation and shows as removed — a gap would read
              as somebody being edited out. Anyone who already saw it still saw it.</>
          }
          confirmLabel="Remove it"
          cancelLabel="Leave it"
          tone="destructive"
          busy={removing}
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />

        {onReply && m.replyCount > 0 && (
          <button
            type="button"
            onClick={onReply}
            className="mt-1 text-[11px]"
            style={{ color: "var(--yg-info)" }}
          >
            {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------- thread */

function Thread({
  channelId, parent, initialReplies, me, canPost, linkOptions, members, onClose, onError, onReplied,
}: {
  channelId: string;
  parent: Message;
  initialReplies: Message[];
  me: { id: string; name: string };
  canPost: boolean;
  linkOptions: LinkOption[];
  members: { id: string; name: string; email: string }[];
  onClose: () => void;
  onError: (s: string) => void;
  onReplied: () => void;
}) {
  const [replies, setReplies] = useState<Message[]>(initialReplies);

  const load = useCallback(async () => {
    const res = await fetch(
      `/api/v1/channels/${channelId}/messages?parent_id=${parent.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const { data } = (await res.json()) as { data: Message[] };
    setReplies(data);
  }, [channelId, parent.id]);

  usePoll(load, POLL_MS);

  return (
    <aside
      className={
        // Below lg it is the whole pane rather than a column beside one — "Reply"
        // opened a panel that was `hidden lg:flex`, so on a phone the button did
        // nothing at all.
        "absolute inset-0 z-10 flex flex-col lg:static lg:z-auto lg:w-96 lg:shrink-0"
      }
      style={{ background: "var(--yg-bg-app)", borderLeft: "1px solid var(--yg-surface-2)" }}
    >
      <header
        className="flex shrink-0 items-center justify-between px-3 py-3"
        style={{ borderBottom: "1px solid var(--yg-surface-2)" }}
      >
        <h2 className="font-display text-sm">Thread</h2>
        <button type="button" onClick={onClose} aria-label="Close thread">
          <X size={14} className="text-text-muted" aria-hidden />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <MessageRow message={parent} me={me} onError={onError} onRemoved={() => {}} />
        <div className="my-2 h-px" style={{ background: "var(--yg-surface-2)" }} />
        {replies.map((r, i) => (
          <MessageRow
            key={r.id}
            message={r}
            previous={replies[i - 1]}
            me={me}
            onError={onError}
            onRemoved={() => setReplies((prev) => prev.map((x) =>
              x.id === r.id ? { ...x, deleted: true, body: "" } : x))}
          />
        ))}
        {replies.length === 0 && (
          <p className="px-2 py-4 text-xs text-text-muted">No replies yet.</p>
        )}
      </div>

      {canPost && (
        <Composer
          channelId={channelId}
          parentId={parent.id}
          linkOptions={linkOptions}
          members={members}
          compact
          onPosted={(m) => { setReplies((prev) => [...prev, m]); onReplied(); }}
          onError={onError}
        />
      )}
    </aside>
  );
}

/* --------------------------------------------------------------------- composer */

function Composer({
  channelId, parentId, linkOptions, members, compact, onPosted, onError,
}: {
  channelId: string;
  parentId?: string;
  linkOptions: LinkOption[];
  members: { id: string; name: string; email: string }[];
  compact?: boolean;
  onPosted: (m: Message) => void;
  onError: (s: string) => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [links, setLinks] = useState<LinkOption[]>([]);
  const [picking, setPicking] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const [mentioning, setMentioning] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  async function upload(file: File) {
    setBusy(true);
    try {
      const presign = await fetch("/api/v1/attachments/presign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          purpose: "CHAT_ATTACHMENT", file_name: file.name,
          mime_type: file.type || "application/octet-stream", size_bytes: file.size,
        }),
      });
      if (!presign.ok) { onError(errorOf(await presign.json().catch(() => null))); return; }
      const { attachment_id, upload_url } = await presign.json();

      const put = await fetch(upload_url, { method: "PUT", body: file });
      if (!put.ok) { onError("That file could not be uploaded"); return; }

      await fetch("/api/v1/attachments/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attachment_id }),
      });
      setFiles((prev) => [...prev, { id: attachment_id, name: file.name }]);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const trimmed = body.trim();
    if (!trimmed && files.length === 0 && links.length === 0) return;

    setBusy(true);
    const res = await fetch(`/api/v1/channels/${channelId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: trimmed,
        parent_id: parentId ?? null,
        attachment_ids: files.map((f) => f.id),
        links: links.map((l) => ({ type: l.type, id: l.id })),
      }),
    });
    setBusy(false);
    if (!res.ok) { onError(errorOf(await res.json().catch(() => null))); return; }

    const created = await res.json();
    onPosted({
      id: created.id, body: trimmed, authorId: created.authorId, author: created.author,
      createdAt: created.createdAt, editedAt: null, deleted: false,
      parentId: created.parentId ?? null, replyCount: 0, lastReplyAt: null,
      attachments: files.map((f) => ({ id: f.id, fileName: f.name, mimeType: null, sizeBytes: null })),
      links: links.map((l) => ({ type: l.type, id: l.id, humanId: l.label, label: l.label, status: null })),
      mentionsMe: false,
    });
    setBody("");
    setFiles([]);
    setLinks([]);
  }

  const matchesLink = linkOptions.filter((o) =>
    `${o.label} ${o.hint}`.toLowerCase().includes(linkQuery.trim().toLowerCase()));

  // @ at the end of what has been typed opens the member list.
  const mentionMatches = mentioning
    ? members.filter((m) => {
        const at = body.lastIndexOf("@");
        const typed = at === -1 ? "" : body.slice(at + 1).toLowerCase();
        return `${m.name} ${m.email}`.toLowerCase().includes(typed);
      }).slice(0, 6)
    : [];

  return (
    <div className="shrink-0 px-3 py-3" style={{ borderTop: "1px solid var(--yg-surface-2)" }}>
      {(files.length > 0 || links.length > 0) && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
              >
                <Paperclip size={11} aria-hidden /> {f.name} <X size={11} aria-hidden />
              </button>
            </li>
          ))}
          {links.map((l) => (
            <li key={`${l.type}:${l.id}`}>
              <button
                type="button"
                onClick={() => setLinks((prev) => prev.filter((x) => x.id !== l.id))}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                style={{ background: "var(--yg-surface-2)", color: "var(--yg-text-soft)" }}
              >
                {l.label} <X size={11} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {picking && (
        <div
          className="mb-2 rounded-lg p-2"
          style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
        >
          <input
            autoFocus
            value={linkQuery}
            onChange={(e) => setLinkQuery(e.target.value)}
            placeholder="Find a reimbursement, ticket, vendor request or vendor"
            className="w-full bg-transparent text-sm outline-none"
            aria-label="Find a record to link"
          />
          <ul className="mt-1 max-h-44 overflow-y-auto">
            {matchesLink.slice(0, 20).map((o) => (
              <li key={`${o.type}:${o.id}`}>
                <button
                  type="button"
                  onClick={() => {
                    setLinks((prev) => prev.some((x) => x.id === o.id) ? prev : [...prev, o]);
                    setPicking(false);
                    setLinkQuery("");
                  }}
                  className="w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-2"
                >
                  <span className="tnum">{o.label}</span>
                  <span className="ml-2 text-text-muted">{o.hint}</span>
                </button>
              </li>
            ))}
            {matchesLink.length === 0 && (
              <li className="px-2 py-1 text-xs text-text-muted">Nothing matches.</li>
            )}
          </ul>
        </div>
      )}

      {mentionMatches.length > 0 && (
        <ul
          className="mb-2 rounded-lg p-1"
          style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
        >
          {mentionMatches.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => {
                  const at = body.lastIndexOf("@");
                  setBody(`${body.slice(0, at)}@${m.email} `);
                  setMentioning(false);
                  input.current?.focus();
                }}
                className="w-full rounded px-2 py-1 text-left text-xs hover:bg-surface-2"
              >
                {m.name} <span className="text-text-muted">{m.email}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="flex items-end gap-1.5 rounded-[18px] px-3 py-2.5"
        style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
      >
        <textarea
          ref={input}
          rows={compact ? 1 : 2}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            // Only while the @ is still the last thing typed.
            const at = e.target.value.lastIndexOf("@");
            setMentioning(at !== -1 && !e.target.value.slice(at).includes(" "));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === "Escape") { setMentioning(false); setPicking(false); }
          }}
          placeholder={parentId ? "Reply…" : "Message — Enter to send, Shift+Enter for a new line"}
          className="max-h-40 min-h-0 w-full resize-none bg-transparent text-sm outline-none"
          aria-label="Write a message"
        />

        <label className="tap cursor-pointer text-text-muted hover:text-text">
          <Paperclip size={17} aria-hidden />
          <span className="sr-only">Attach a file</span>
          <input
            type="file"
            className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }}
          />
        </label>

        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          className="tap text-[15px] text-text-muted hover:text-text"
          aria-label="Link a record"
        >
          #
        </button>

        <button
          type="button"
          disabled={busy || (!body.trim() && files.length === 0 && links.length === 0)}
          onClick={send}
          className="tap shrink-0 rounded-full disabled:opacity-40"
          style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
          aria-label="Send"
        >
          <Send size={17} aria-hidden />
        </button>
      </div>
    </div>
  );
}
