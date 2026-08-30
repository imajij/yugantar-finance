import Link from "next/link";
import { redirect } from "next/navigation";
import { Hash, MessageSquare } from "lucide-react";
import { getSession } from "@/lib/session";
import { listChannels } from "@/lib/services/chat";
import { PageTitle } from "@/components/ui";

/**
 * The channel index.
 *
 * On a wide screen the list is already in the sidebar, so this sends you straight
 * to a channel. On a phone there is no sidebar, and `/chat/[id]` links back here
 * with `?list=1` — which is the whole mobile navigation for chat, and it was
 * missing: the sidebar is `md:block`, so a phone landed inside one channel with no
 * way to reach any other.
 */
export default async function ChatIndex({
  searchParams,
}: {
  searchParams: Promise<{ list?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const channels = await listChannels(user);
  const mine = channels.filter((c) => c.isMember);
  const { list } = await searchParams;

  if (list !== "1") {
    const target =
      mine.find((c) => c.unread > 0)
      ?? mine.find((c) => c.isDefault && c.departmentId === user.departmentId)
      ?? mine[0]
      ?? channels[0];
    if (target) redirect(`/chat/${target.id}`);
  }

  if (channels.length === 0) {
    return (
      <div className="p-6 text-[13.5px] text-text-muted">
        No channels yet. One is made for each department as it is created.
      </div>
    );
  }

  const groups = [
    { label: "Channels", items: channels.filter((c) => c.isMember && c.kind === "DEPARTMENT" && !c.archived) },
    { label: "Direct messages", items: channels.filter((c) => c.isMember && c.kind === "DIRECT") },
    { label: "Oversight — you are not in these", items: channels.filter((c) => !c.isMember) },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="w-full overflow-y-auto p-4">
      <PageTitle>Channels</PageTitle>
      <div className="flex flex-col gap-6">
        {groups.map((g) => (
          <section key={g.label} className="flex flex-col gap-2">
            <h2 className="meta-label">{g.label}</h2>
            {g.items.map((c) => (
              <Link
                key={c.id}
                href={`/chat/${c.id}`}
                className="flex items-center gap-3 rounded-[var(--r-card)] p-3.5"
                style={{ background: "var(--yg-surface)", border: "1px solid var(--yg-surface-2)" }}
              >
                {c.kind === "DIRECT"
                  ? <MessageSquare size={16} className="shrink-0 text-text-muted" aria-hidden />
                  : <Hash size={16} className="shrink-0 text-text-muted" aria-hidden />}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className={`truncate text-[14px] ${c.unread > 0 ? "font-medium" : ""}`}>{c.name}</span>
                  {c.lastMessagePreview && (
                    <span className="truncate text-[12px] text-text-muted">{c.lastMessagePreview}</span>
                  )}
                </span>
                {c.mentions > 0 ? (
                  <span
                    className="tnum shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
                  >
                    {c.mentions}
                  </span>
                ) : c.unread > 0 ? (
                  <span
                    className="tnum shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                    style={{ background: "var(--yg-accent)", color: "var(--yg-on-accent)" }}
                  >
                    {c.unread > 99 ? "99+" : c.unread}
                  </span>
                ) : null}
              </Link>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
