import Link from "next/link";
import { redirect } from "next/navigation";
import { Bell } from "lucide-react";
import { getSession } from "@/lib/session";
import { inbox } from "@/lib/services/notifications";
import { Card, Empty, PageTitle } from "@/components/ui";
import { MarkAllRead } from "./actions";

const HREF: Partial<Record<string, (id: string) => string>> = {
  REIMBURSEMENT: (id) => `/requests/${id}`,
  VENDOR_REQUEST: (id) => `/vendors/requests/${id}`,
  TICKET: (id) => `/tickets/${id}`,
  LINE_ITEM: (id) => `/budget/${id}`,
  INCOME_ENTRY: () => "/income",
};

/** PRD 11 — in-app is the channel that exists today; email rows are written unsent. */
export default async function NotificationsPage() {
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const items = await inbox(user);
  const unread = items.filter((n) => !n.readAt);

  return (
    <>
      <PageTitle action={unread.length > 0 ? <MarkAllRead /> : undefined}>Notifications</PageTitle>

      {items.length === 0 ? (
        <Empty icon={<Bell size={24} aria-hidden />} title="Nothing yet">
          You hear about things waiting on your decision, anything mentioning you by name, and
          money moving in a department you run. Nothing else.
        </Empty>
      ) : (
        <div className="space-y-2">
          {items.map((n) => {
            const href = n.entityType && n.entityId ? HREF[n.entityType]?.(n.entityId) : undefined;
            const body = (
              <Card className={n.readAt ? "opacity-60" : ""}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-text">{n.title}</p>
                    {n.body && <p className="mt-0.5 text-xs text-text-soft">{n.body}</p>}
                  </div>
                  <span className="tnum shrink-0 text-xs text-text-muted">
                    {new Date(n.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
                  </span>
                </div>
              </Card>
            );
            return href
              ? <Link key={n.id} href={href} className="block">{body}</Link>
              : <div key={n.id}>{body}</div>;
          })}
        </div>
      )}
    </>
  );
}
