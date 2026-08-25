import { notFound as nf, redirect } from "next/navigation";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { reimbursementRequests, tickets, vendorRequests, vendors } from "@/db/schema";
import { getSession } from "@/lib/session";
import { can } from "@/lib/authz";
import { getChannel, listMessages, markRead } from "@/lib/services/chat";
import { formatPaise } from "@/lib/money";
import { Conversation, type LinkOption, type Message } from "./conversation";

export const dynamic = "force-dynamic";

/**
 * One channel.
 *
 * Opening it is where an administrator's oversight read gets written to the audit
 * log — inside `getChannel`, so there is no path to a channel's contents that skips
 * it.
 */
export default async function ChannelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSession();
  if (!user) redirect("/sign-in");

  const channel = await getChannel(user, id).catch(() => null);
  if (!channel) nf();

  const [messages] = await Promise.all([
    listMessages(user, id, { limit: 100 }),
    // A member's marker moves on open; an administrator looking in has none to move.
    markRead(user, id),
  ]);

  return (
    <Conversation
      // Keyed on the channel so moving between two of them remounts rather than
      // resyncing state in an effect — the messages of one must never flash up
      // under the header of another.
      key={channel.id}
      channel={{
        id: channel.id,
        kind: channel.kind,
        displayName: channel.displayName,
        topic: channel.topic,
        isMember: channel.isMember,
        isOversight: channel.isOversight,
        archived: channel.archivedAt !== null,
        members: channel.members,
        administratorsCanRead: channel.administratorsCanRead,
      }}
      initial={messages.map(serialise)}
      me={{ id: user.id, name: user.name }}
      linkOptions={channel.isMember ? await linkables(user) : []}
    />
  );
}

const serialise = (m: Awaited<ReturnType<typeof listMessages>>[number]): Message => ({
  ...m,
  createdAt: m.createdAt.toISOString(),
  editedAt: m.editedAt ? m.editedAt.toISOString() : null,
  lastReplyAt: m.lastReplyAt ? m.lastReplyAt.toISOString() : null,
});

/**
 * What this person could link into a message.
 *
 * Scoped to what they can already see — the service refuses anything else, so
 * offering more would just be a picker that fails. Recent rather than exhaustive:
 * a channel conversation is about what is happening now.
 */
async function linkables(user: NonNullable<Awaited<ReturnType<typeof getSession>>>): Promise<LinkOption[]> {
  const options: LinkOption[] = [];
  const scope = { festId: user.festId, departmentId: user.departmentId };
  const festWide = can(user, "reimbursement.view", { festId: user.festId, departmentId: undefined });

  const [claims, ticketRows, vendorRequestRows, vendorRows] = await Promise.all([
    db.select({
      id: reimbursementRequests.id, humanId: reimbursementRequests.humanId,
      description: reimbursementRequests.description, amountPaise: reimbursementRequests.amountPaise,
    }).from(reimbursementRequests)
      .where(and(
        eq(reimbursementRequests.festId, user.festId),
        isNull(reimbursementRequests.deletedAt),
        festWide ? undefined : or(
          eq(reimbursementRequests.departmentId, user.departmentId),
          eq(reimbursementRequests.submitterId, user.id),
        ),
      ))
      .orderBy(desc(reimbursementRequests.createdAt)).limit(40),

    db.select({ id: tickets.id, humanId: tickets.humanId, title: tickets.title }).from(tickets)
      .where(and(
        eq(tickets.festId, user.festId),
        isNull(tickets.deletedAt),
        can(user, "ticket.view", { festId: user.festId }) ? undefined : or(
          eq(tickets.requestingDepartmentId, user.departmentId),
          eq(tickets.targetDepartmentId, user.departmentId),
        ),
      ))
      .orderBy(desc(tickets.createdAt)).limit(40),

    can(user, "vendorRequest.view", scope)
      ? db.select({
          id: vendorRequests.id, humanId: vendorRequests.humanId,
          description: vendorRequests.description,
        }).from(vendorRequests)
          .where(and(eq(vendorRequests.festId, user.festId), isNull(vendorRequests.deletedAt)))
          .orderBy(desc(vendorRequests.createdAt)).limit(40)
      : Promise.resolve([]),

    can(user, "vendor.view", scope)
      ? db.select({ id: vendors.id, name: vendors.name }).from(vendors)
          .where(and(eq(vendors.festId, user.festId), isNull(vendors.deletedAt)))
          .orderBy(vendors.name).limit(40)
      : Promise.resolve([]),
  ]);

  for (const r of claims) {
    options.push({
      type: "REIMBURSEMENT", id: r.id, label: r.humanId,
      hint: `${formatPaise(r.amountPaise)} · ${r.description.slice(0, 40)}`,
    });
  }
  for (const t of ticketRows) {
    options.push({ type: "TICKET", id: t.id, label: t.humanId, hint: t.title.slice(0, 50) });
  }
  for (const v of vendorRequestRows) {
    options.push({ type: "VENDOR_REQUEST", id: v.id, label: v.humanId, hint: v.description.slice(0, 50) });
  }
  for (const v of vendorRows) {
    options.push({ type: "VENDOR", id: v.id, label: v.name, hint: "vendor" });
  }
  return options;
}
