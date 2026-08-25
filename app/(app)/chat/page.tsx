import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { listChannels } from "@/lib/services/chat";

/** Straight into the channel with something new in it, or the department's default. */
export default async function ChatIndex() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const channels = await listChannels(user);
  const mine = channels.filter((c) => c.isMember);
  const target =
    mine.find((c) => c.unread > 0)
    ?? mine.find((c) => c.isDefault && c.departmentId === user.departmentId)
    ?? mine[0]
    ?? channels[0];

  if (target) redirect(`/chat/${target.id}`);

  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-text-muted">
      No channels yet. One is made for each department as it is created.
    </div>
  );
}
