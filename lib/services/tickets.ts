/**
 * Work tickets (PRD 7.7, 20.9). Cross-department asks with an owner and a deadline.
 * Deliberately not a project tracker: no subtasks, no dependencies, no sprints.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  auditEvents, comments, departments, lineItems, tickets, ticketWatchers, users,
} from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, satisfiesActorConstraints, type Actor } from "@/lib/authz";
import type { SessionUser } from "@/lib/session";
import { nextHumanId, PREFIXES } from "@/lib/human-id";
import {
  assertTicketTransition, type TicketAction, type TicketState,
} from "@/lib/state-machines/ticket";
import { notify } from "./notifications";
import { recordAudit, snapshot } from "./audit";

const AUDITED = [
  "status", "assigneeId", "priority", "dueAt", "title", "targetDepartmentId", "escalatedAt",
] as const;

export interface CreateTicketInput {
  title: string;
  description: string;
  targetDepartmentId: string;
  dueAt: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  location?: string | null;
  estimatedCostPaise?: number | null;
  lineItemId?: string | null;
  watcherIds?: string[];
}

export async function createTicket(actor: SessionUser, input: CreateTicketInput) {
  assertCan(actor, "ticket.create", { festId: actor.festId, departmentId: actor.departmentId });

  if (input.targetDepartmentId === actor.departmentId) {
    throw new ApiError("VALIDATION_ERROR", "A ticket asks another department for work; use your own board instead");
  }

  return db.transaction(async (tx) => {
    const [target] = await tx.select({ id: departments.id, name: departments.name }).from(departments)
      .where(and(
        eq(departments.id, input.targetDepartmentId),
        eq(departments.festId, actor.festId),
        eq(departments.isActive, true),
      )).limit(1);
    if (!target) throw notFound("Department");

    if (input.lineItemId) await assertLineItemVisible(tx, actor, input.lineItemId);

    const humanId = await nextHumanId(tx, actor.festId, PREFIXES.ticket);
    const [row] = await tx.insert(tickets).values({
      festId: actor.festId,
      humanId,
      title: input.title,
      description: input.description,
      requestingDepartmentId: actor.departmentId,
      requesterId: actor.id,
      targetDepartmentId: input.targetDepartmentId,
      priority: input.priority ?? "MEDIUM",
      dueAt: new Date(input.dueAt),
      location: input.location ?? null,
      estimatedCostPaise: input.estimatedCostPaise ?? null,
      lineItemId: input.lineItemId ?? null,
    }).returning();

    if (input.watcherIds?.length) {
      await tx.insert(ticketWatchers)
        .values(input.watcherIds.map((userId) => ({ ticketId: row.id, userId })))
        .onConflictDoNothing();
    }

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET", entityId: row.id, actorId: actor.id,
      action: "ticket.create", after: snapshot(row, AUDITED),
    });
    await notify(tx, {
      festId: actor.festId, type: "ticket.opened", entityType: "TICKET", entityId: row.id,
      title: `${row.humanId}: ${row.title}`,
      body: `${target.name} has a new request from ${actor.name}`,
      toDepartmentHods: [target.id],
    });
    return row;
  });
}

export interface TicketTransitionBody {
  reason?: string;
  question?: string;
  answer?: string;
  assignee_id?: string;
}

export async function transitionTicket(
  actor: SessionUser, id: string, action: TicketAction, body: TicketTransitionBody = {},
) {
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);
    const resource = {
      festId: actor.festId,
      departmentId: before.requestingDepartmentId,
      requestingDepartmentId: before.requestingDepartmentId,
      targetDepartmentId: before.targetDepartmentId,
      submitterId: before.requesterId,
      requesterId: before.requesterId,
      assigneeId: before.assigneeId ?? undefined,
      status: before.status,
    };

    const transition = assertTicketTransition(
      before.status, action, actor.role, body as Record<string, unknown>,
    );
    if (!satisfiesActorConstraints(transition.actor, actor, resource)) {
      throw new ApiError("FORBIDDEN", `You may not ${action} this ticket`);
    }
    assertActionPermission(actor, action, resource);

    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };
    let to: TicketState;

    switch (transition.to) {
      // NEEDS_INFO remembers where it came from so REPLY_INFO can put it back (7.7).
      case "PREVIOUS": {
        to = (before.previousStatus as TicketState | null) ?? "OPEN";
        patch.previousStatus = null;
        patch.infoRequest = null;
        break;
      }
      case "SAME":
        to = before.status;
        break;
      default:
        to = transition.to as TicketState;
    }

    switch (action) {
      case "ACCEPT":
        // Accepting without naming someone makes the accepting HOD the owner.
        Object.assign(patch, { triagedAt: now, assigneeId: before.assigneeId ?? actor.id });
        break;
      case "REJECT":
        patch.rejectReason = body.reason;
        break;
      case "ASK_INFO":
        Object.assign(patch, { previousStatus: before.status, infoRequest: body.question });
        break;
      case "START":
        patch.startedAt = now;
        break;
      case "BLOCK":
        patch.blockedReason = body.reason;
        break;
      case "UNBLOCK":
        patch.blockedReason = null;
        break;
      case "MARK_DONE":
        Object.assign(patch, { doneAt: now, doneRemindedAt: null });
        break;
      case "CONFIRM":
        patch.closedAt = now;
        break;
      case "REOPEN":
        Object.assign(patch, { doneAt: null, closedAt: null });
        break;
      case "REASSIGN": {
        const [assignee] = await tx.select({ id: users.id, departmentId: users.departmentId })
          .from(users).where(and(eq(users.id, body.assignee_id!), eq(users.festId, actor.festId))).limit(1);
        if (!assignee) throw notFound("Assignee");
        if (assignee.departmentId !== before.targetDepartmentId) {
          throw new ApiError("VALIDATION_ERROR", "The assignee must be in the department the ticket was sent to");
        }
        patch.assigneeId = assignee.id;
        break;
      }
      case "ESCALATE":
        // 7.7 — escalation is a mark, not a state.
        Object.assign(patch, { escalatedAt: now, escalatedBy: actor.id });
        break;
    }

    const [after] = await tx.update(tickets).set({ ...patch, status: to })
      .where(and(eq(tickets.id, id), eq(tickets.status, before.status)))
      .returning();
    if (!after) throw conflict("This ticket changed while you were looking at it");

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET", entityId: id, actorId: actor.id,
      action: `ticket.transition.${action}`,
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
      reason: body.reason ?? body.question ?? body.answer ?? null,
    });
    await notifyTransition(tx, actor, after, action);
    return after;
  });
}

function assertActionPermission(
  actor: Actor, action: TicketAction,
  resource: { festId: string; departmentId: string; targetDepartmentId: string; submitterId: string; assigneeId?: string },
) {
  if (action === "ACCEPT" || action === "REJECT" || action === "REASSIGN") {
    assertCan(actor, "ticket.triage", resource);
  }
  if (["START", "BLOCK", "UNBLOCK", "MARK_DONE"].includes(action)) {
    assertCan(actor, "ticket.work", resource);
  }
  if (action === "CONFIRM" || action === "REOPEN" || action === "CANCEL") {
    assertCan(actor, "ticket.close", resource);
  }
}

async function notifyTransition(
  tx: Tx, actor: SessionUser,
  ticket: { id: string; festId: string; humanId: string; title: string; requesterId: string;
            assigneeId: string | null; targetDepartmentId: string; status: string },
  action: TicketAction,
) {
  const toRequester = ["ACCEPT", "REJECT", "ASK_INFO", "MARK_DONE", "BLOCK"];
  const toAssignee = ["REPLY_INFO", "REOPEN", "REASSIGN", "ESCALATE", "CANCEL"];
  const recipients = new Set<string>();
  if (toRequester.includes(action)) recipients.add(ticket.requesterId);
  if (toAssignee.includes(action) && ticket.assigneeId) recipients.add(ticket.assigneeId);
  recipients.delete(actor.id);                      // never notify yourself about your own action

  await notify(tx, {
    festId: ticket.festId,
    type: `ticket.${action.toLowerCase()}`,
    entityType: "TICKET",
    entityId: ticket.id,
    title: `${ticket.humanId}: ${ticket.title}`,
    body: `${actor.name} → ${ticket.status}`,
    toUsers: [...recipients],
    toDepartmentHods: action === "ESCALATE" ? [ticket.targetDepartmentId] : [],
  });
}

async function load(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(tickets)
    .where(and(eq(tickets.id, id), eq(tickets.festId, actor.festId), isNull(tickets.deletedAt))).limit(1);
  if (!row) throw notFound("Ticket");
  assertCan(actor, "ticket.view", {
    festId: actor.festId,
    departmentId: row.requestingDepartmentId,
    requestingDepartmentId: row.requestingDepartmentId,
    targetDepartmentId: row.targetDepartmentId,
    submitterId: row.requesterId,
    requesterId: row.requesterId,
    assigneeId: row.assigneeId ?? undefined,
  });
  return row;
}

async function assertLineItemVisible(tx: Tx, actor: Actor, lineItemId: string) {
  const [item] = await tx.select({ id: lineItems.id }).from(lineItems)
    .where(and(eq(lineItems.id, lineItemId), eq(lineItems.festId, actor.festId), isNull(lineItems.deletedAt)))
    .limit(1);
  if (!item) throw notFound("Line item");
}

interface TicketNames extends Record<string, unknown> {
  requesting_department: string;
  target_department: string;
  requester: string;
  assignee: string | null;
  line_item: string | null;
}

/** 20.9 — the detail screen in one call. */
export async function getTicketDetail(actor: Actor, id: string) {
  const row = await load(db as unknown as Tx, actor, id);
  const [thread, timeline, watchers, meta] = await Promise.all([
    db.select({ id: comments.id, body: comments.body, createdAt: comments.createdAt, editedAt: comments.editedAt, author: users.name })
      .from(comments).innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.entityType, "TICKET"), eq(comments.entityId, id)))
      .orderBy(comments.createdAt),
    db.select({ action: auditEvents.action, reason: auditEvents.reason, createdAt: auditEvents.createdAt, actor: users.name })
      .from(auditEvents).leftJoin(users, eq(users.id, auditEvents.actorId))
      .where(and(eq(auditEvents.entityType, "TICKET"), eq(auditEvents.entityId, id)))
      .orderBy(auditEvents.createdAt),
    db.select({ id: users.id, name: users.name }).from(ticketWatchers)
      .innerJoin(users, eq(users.id, ticketWatchers.userId))
      .where(eq(ticketWatchers.ticketId, id)),
    db.execute<TicketNames>(sql`
      select rq.name as requesting_department, tg.name as target_department,
             ru.name as requester, au.name as assignee, li.name as line_item
        from tickets t
        join departments rq on rq.id = t.requesting_department_id
        join departments tg on tg.id = t.target_department_id
        join users ru on ru.id = t.requester_id
        left join users au on au.id = t.assignee_id
        left join line_items li on li.id = t.line_item_id
       where t.id = ${id}
    `),
  ]);
  const names = (meta as unknown as TicketNames[])[0];
  return { ...row, ...names, comments: thread, timeline, watchers };
}

export type TicketScope = "inbox" | "outgoing" | "mine" | "all";

/** The four board views of 9.5, all from one query shape. */
export async function listTickets(
  actor: Actor,
  opts: { scope: TicketScope; status?: string[]; priority?: string; overdue?: boolean; limit?: number } = { scope: "inbox" },
) {
  const scopeFilter = {
    inbox: sql`t.target_department_id = ${actor.departmentId}`,
    outgoing: sql`t.requesting_department_id = ${actor.departmentId}`,
    mine: sql`t.assignee_id = ${actor.id}`,
    all: actor.role === "MANAGEMENT" || actor.role === "FINANCE_HOD"
      ? sql`true`
      : sql`(t.target_department_id = ${actor.departmentId} or t.requesting_department_id = ${actor.departmentId})`,
  }[opts.scope];

  const rows = (await db.execute(sql`
    select t.id, t.human_id, t.title, t.status, t.priority, t.due_at, t.escalated_at,
           t.estimated_cost_paise, t.location,
           rq.name as requesting_department, tg.name as target_department,
           ru.name as requester, au.name as assignee,
           (t.due_at < now() and t.status not in ('CLOSED','REJECTED','CANCELLED')) as overdue,
           extract(epoch from (now() - t.created_at)) / 3600 as age_hours,
           (select count(*) from comments c
             where c.entity_type = 'TICKET' and c.entity_id = t.id) as comment_count
      from tickets t
      join departments rq on rq.id = t.requesting_department_id
      join departments tg on tg.id = t.target_department_id
      join users ru on ru.id = t.requester_id
      left join users au on au.id = t.assignee_id
     where t.fest_id = ${actor.festId} and t.deleted_at is null
       and ${scopeFilter}
       ${opts.status?.length ? sql`and t.status = any(${opts.status}::ticket_status[])` : sql``}
       ${opts.priority ? sql`and t.priority = ${opts.priority}::ticket_priority` : sql``}
       ${opts.overdue ? sql`and t.due_at < now() and t.status not in ('CLOSED','REJECTED','CANCELLED')` : sql``}
     order by
       case t.priority when 'URGENT' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end,
       t.due_at asc
     limit ${opts.limit ?? 200}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    human_id: String(r.human_id),
    title: String(r.title),
    status: String(r.status),
    priority: String(r.priority),
    due_at: r.due_at as Date,
    overdue: Boolean(r.overdue),
    escalated: r.escalated_at !== null,
    age_hours: Math.round(Number(r.age_hours)),
    requesting_department: String(r.requesting_department),
    target_department: String(r.target_department),
    requester: String(r.requester),
    assignee: (r.assignee as string) ?? null,
    location: (r.location as string) ?? null,
    estimated_cost_paise: r.estimated_cost_paise === null ? null : Number(r.estimated_cost_paise),
    comment_count: Number(r.comment_count),
  }));
}

/** Board counts for the tab bar, one round trip. */
export async function ticketCounts(actor: Actor) {
  const [row] = (await db.execute(sql`
    select
      count(*) filter (where t.target_department_id = ${actor.departmentId}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))          as inbox,
      count(*) filter (where t.target_department_id = ${actor.departmentId}
                         and t.status = 'OPEN')                                          as untriaged,
      count(*) filter (where t.requesting_department_id = ${actor.departmentId}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))          as outgoing,
      count(*) filter (where t.assignee_id = ${actor.id}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))          as mine,
      count(*) filter (where t.requester_id = ${actor.id} and t.status = 'DONE')         as awaiting_my_confirmation,
      count(*) filter (where t.due_at < now()
                         and t.status not in ('CLOSED','REJECTED','CANCELLED')
                         and (t.target_department_id = ${actor.departmentId}
                              or t.requesting_department_id = ${actor.departmentId}))    as overdue
    from tickets t
    where t.fest_id = ${actor.festId} and t.deleted_at is null
  `)) as unknown as Record<string, string>[];
  return {
    inbox: Number(row.inbox), untriaged: Number(row.untriaged), outgoing: Number(row.outgoing),
    mine: Number(row.mine), awaitingMyConfirmation: Number(row.awaiting_my_confirmation),
    overdue: Number(row.overdue),
  };
}
