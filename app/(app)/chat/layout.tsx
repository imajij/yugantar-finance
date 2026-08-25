import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { departments } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { directCandidates, listChannels, backfillChannels } from "@/lib/services/chat";
import { ChannelSidebar } from "./sidebar";

export const dynamic = "force-dynamic";

/**
 * The chat shell: the channel list beside whatever channel is open.
 *
 * A layout rather than a page so switching channels does not re-fetch the list —
 * and so the unread counts on the left stay live while you read on the right.
 *
 * It no longer sets its own height with `calc(100vh - 2rem)`, which was a guess at
 * what the app shell had left over and was wrong whenever the mobile header
 * appeared. The shell's `main` is `min-h-0 flex-1`, so this just fills it.
 */
export default async function ChatLayout({
  children, params,
}: {
  children: React.ReactNode;
  params?: Promise<{ id?: string }>;
}) {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  // A fest that predates channels has departments with none. Idempotent.
  await backfillChannels(user);

  const [channels, people, [dept]] = await Promise.all([
    listChannels(user),
    directCandidates(user),
    db.select({ name: departments.name }).from(departments).where(eq(departments.id, user.departmentId)),
  ]);

  const active = (await params)?.id;

  return (
    <div
      className="flex min-h-0 flex-1 overflow-hidden rounded-[var(--r-shell)]"
      style={{ background: "var(--yg-bg-app)", border: "1px solid var(--yg-surface-2)" }}
    >
      <aside
        className="hidden w-[262px] shrink-0 overflow-y-auto md:block"
        style={{ background: "var(--yg-surface)", borderRight: "1px solid var(--yg-surface-2)" }}
      >
        <ChannelSidebar
          channels={channels.map((c) => ({
            ...c,
            lastMessageAt: c.lastMessageAt ? c.lastMessageAt.toISOString() : null,
          }))}
          people={people}
          activeId={active}
          canCreate={can(user, "channel.manage", { festId: user.festId, departmentId: user.departmentId })}
          myDepartmentId={user.departmentId}
          myDepartmentName={dept?.name ?? "Your department"}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
