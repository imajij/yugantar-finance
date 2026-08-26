/**
 * Work tickets (PRD 7.7, 20.9). Cross-department asks with an owner and a deadline.
 *
 * The governance half is unchanged and not negotiable: a ticket is a request from
 * one department to another, and its status only ever moves through the state
 * machine in `lib/state-machines/ticket.ts` (18.2 rule 2).
 *
 * On top of that sits a planning layer — labels, projects, cycles, sub-tickets —
 * borrowed from Linear. It exists because a fest week generates hundreds of these
 * and five fixed tabs cannot organise them. None of it can decide anything: no
 * label grants a permission, no project changes who may accept work. It only
 * changes how the same tickets can be grouped and found.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  auditEvents, comments, cycles, departments, entityLinks, lineItems, projects,
  ticketLabelLinks, ticketLabels, tickets, ticketWatchers, users,
} from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, satisfiesActorConstraints, type Actor } from "@/lib/authz";
import type { SessionUser } from "@/lib/session";
import { nextHumanId, PREFIXES } from "@/lib/human-id";
import {
  assertTicketTransition, CATEGORY_OF, statesIn,
  type TicketAction, type TicketCategory, type TicketState,
} from "@/lib/state-machines/ticket";
import { asDate } from "@/lib/rows";
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
  /** Linear's planning axes. All optional; none of them gate anything. */
  labelIds?: string[];
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
}

export async function createTicket(actor: SessionUser, input: CreateTicketInput) {
  assertCan(actor, "ticket.create", { festId: actor.festId, departmentId: actor.departmentId });

  /*
   * Who a ticket may be addressed to depends on who is raising it.
   *
   * A member raises work with their own department's head and nobody else. They do
   * not negotiate across departments — that is what having a head is for — and a
   * member who could address Logistics directly would be committing another
   * department's people without its head knowing.
   *
   * Everybody else is the opposite: a ticket from an HOD, Finance or Management is
   * one department asking another, so it may not be addressed to itself.
   */
  if (actor.role === "MEMBER") {
    if (input.targetDepartmentId !== actor.departmentId) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Ask your own department's head. They raise it with another department if that is what it needs.",
      );
    }
  } else if (input.targetDepartmentId === actor.departmentId) {
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
    await assertPlanningRefs(tx, actor, input);

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
      projectId: input.projectId ?? null,
      cycleId: input.cycleId ?? null,
      parentId: input.parentId ?? null,
    }).returning();

    if (input.labelIds?.length) await setLabels(tx, row.id, input.labelIds);

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
  // BACKLOG and SCHEDULE are triage decisions like ACCEPT and REJECT — "yes, ours,
  // and not this week" is an answer to the same question. The state machine's
  // TARGET_DEPT_HOD constraint already says so; this is the `can()` half of it,
  // which is what 18.2 rule 1 asks every handler to go through.
  if (["ACCEPT", "REJECT", "REASSIGN", "BACKLOG", "SCHEDULE"].includes(action)) {
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

/**
 * Every planning reference, checked against this fest.
 *
 * A UUID is not a secret (18.2 rule 10). A project, cycle, label or parent id from
 * another fest passes every permission check — `ticket.plan` says nothing about
 * *which* project — and would file this fest's work under that one's board. So each
 * is resolved from its own row with `fest_id` in the WHERE clause, and a miss is a
 * plain not-found rather than a foreign-key error.
 */
async function assertPlanningRefs(
  tx: Tx, actor: Actor,
  input: { labelIds?: string[]; projectId?: string | null; cycleId?: string | null; parentId?: string | null },
  selfId?: string,
) {
  if (input.projectId) {
    const [row] = await tx.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.festId, actor.festId), isNull(projects.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Project");
  }
  if (input.cycleId) {
    const [row] = await tx.select({ id: cycles.id }).from(cycles)
      .where(and(eq(cycles.id, input.cycleId), eq(cycles.festId, actor.festId))).limit(1);
    if (!row) throw notFound("Cycle");
  }
  if (input.parentId) {
    const [row] = await tx.select({ id: tickets.id, parentId: tickets.parentId }).from(tickets)
      .where(and(eq(tickets.id, input.parentId), eq(tickets.festId, actor.festId), isNull(tickets.deletedAt)))
      .limit(1);
    if (!row) throw notFound("Parent ticket");
    // One level only. A tree of sub-tickets is a project, and there is a table for
    // that; nesting deeper mainly produces boards nobody can read.
    if (row.parentId) {
      throw new ApiError("VALIDATION_ERROR", "That ticket is already a sub-ticket — sub-tickets go one level deep");
    }
    if (selfId) {
      const [child] = await tx.select({ id: tickets.id }).from(tickets)
        .where(and(eq(tickets.parentId, selfId), isNull(tickets.deletedAt))).limit(1);
      if (child) {
        throw new ApiError("VALIDATION_ERROR", "This ticket has sub-tickets of its own, so it cannot become one");
      }
    }
  }
  if (input.labelIds?.length) {
    const found = await tx.select({ id: ticketLabels.id }).from(ticketLabels)
      .where(and(eq(ticketLabels.festId, actor.festId), inArray(ticketLabels.id, input.labelIds)));
    if (found.length !== new Set(input.labelIds).size) throw notFound("Label");
  }
}

/** Labels are set as a whole set, not added one at a time — it is how the UI edits them. */
async function setLabels(tx: Tx, ticketId: string, labelIds: string[]) {
  await tx.delete(ticketLabelLinks).where(eq(ticketLabelLinks.ticketId, ticketId));
  if (labelIds.length === 0) return;
  await tx.insert(ticketLabelLinks)
    .values([...new Set(labelIds)].map((labelId) => ({ ticketId, labelId })))
    .onConflictDoNothing();
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
  project: string | null;
  cycle: string | null;
  parent_human_id: string | null;
  parent_title: string | null;
}

/** 20.9 — the detail screen in one call. */
export async function getTicketDetail(actor: Actor, id: string) {
  const row = await load(db as unknown as Tx, actor, id);
  const [thread, timeline, watchers, meta, labels, children] = await Promise.all([
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
             ru.name as requester, au.name as assignee, li.name as line_item,
             pj.name as project, cy.name as cycle,
             pt.human_id as parent_human_id, pt.title as parent_title
        from tickets t
        join departments rq on rq.id = t.requesting_department_id
        join departments tg on tg.id = t.target_department_id
        join users ru on ru.id = t.requester_id
        left join users au on au.id = t.assignee_id
        left join line_items li on li.id = t.line_item_id
        left join projects pj on pj.id = t.project_id
        left join cycles cy on cy.id = t.cycle_id
        left join tickets pt on pt.id = t.parent_id
       where t.id = ${id}
    `),
    db.select({ id: ticketLabels.id, name: ticketLabels.name, color: ticketLabels.color })
      .from(ticketLabelLinks)
      .innerJoin(ticketLabels, eq(ticketLabels.id, ticketLabelLinks.labelId))
      .where(eq(ticketLabelLinks.ticketId, id))
      .orderBy(ticketLabels.name),
    db.select({
      id: tickets.id, humanId: tickets.humanId, title: tickets.title,
      status: tickets.status, assigneeId: tickets.assigneeId,
    }).from(tickets)
      .where(and(eq(tickets.parentId, id), isNull(tickets.deletedAt)))
      .orderBy(tickets.createdAt),
  ]);
  const names = (meta as unknown as TicketNames[])[0];
  return { ...row, ...names, comments: thread, timeline, watchers, labels, children };
}

/**
 * The board's scopes (PRD 20.9), in Linear's vocabulary.
 *
 * The old tab bar mixed two different axes and called them one list: "Sent" is
 * every ticket *your department* raised, while "Raised by me" is the ones *you*
 * personally typed — a subset, not a sibling. Reading them side by side, nobody
 * could say what either meant. They are kept apart here and named for what they
 * actually filter on: a department axis (`inbox`, `outgoing`) and a person axis
 * (`created`, `assigned`, `subscribed`).
 *
 * `mine` and `raised` remain as aliases so older links and saved URLs still work.
 */
export type TicketScope =
  | "inbox" | "outgoing" | "assigned" | "created" | "subscribed" | "all"
  | "mine" | "raised";

const SCOPE_ALIASES: Record<string, TicketScope> = { mine: "assigned", raised: "created" };

export const normalizeScope = (view: string): TicketScope =>
  (SCOPE_ALIASES[view] ?? view) as TicketScope;

export type GroupBy =
  | "status" | "assignee" | "priority" | "department" | "project" | "cycle" | "label" | "none";

export interface TicketFilters {
  view: TicketScope;
  status?: string[];
  /** Board columns, which collapse several statuses each. */
  categories?: TicketCategory[];
  priority?: string;
  departmentId?: string;
  assigneeId?: string;
  labelIds?: string[];
  projectId?: string;
  cycleId?: string;
  /** Only the children of one ticket — how a parent renders its sub-tickets. */
  parentId?: string;
  overdue?: boolean;
  escalated?: boolean;
  unassigned?: boolean;
  q?: string;
  limit?: number;
}

export interface TicketRow {
  id: string;
  human_id: string;
  title: string;
  status: string;
  category: TicketCategory;
  priority: string;
  due_at: Date;
  overdue: boolean;
  escalated: boolean;
  age_hours: number;
  requesting_department: string;
  requesting_department_id: string;
  target_department: string;
  target_department_id: string;
  requester: string;
  requester_id: string;
  assignee: string | null;
  assignee_id: string | null;
  location: string | null;
  estimated_cost_paise: number | null;
  comment_count: number;
  labels: { id: string; name: string; color: string }[];
  project: string | null;
  project_id: string | null;
  cycle: string | null;
  cycle_id: string | null;
  parent_id: string | null;
  parent_human_id: string | null;
  child_count: number;
  child_done_count: number;
}

/** The board views of 9 and 20.9, all from one query shape. */
export async function listTickets(actor: Actor, opts: TicketFilters = { view: "inbox" }): Promise<TicketRow[]> {
  const view = normalizeScope(opts.view);
  const scopeFilter = {
    inbox: sql`t.target_department_id = ${actor.departmentId}`,
    outgoing: sql`t.requesting_department_id = ${actor.departmentId}`,
    assigned: sql`t.assignee_id = ${actor.id}`,
    created: sql`t.requester_id = ${actor.id}`,
    subscribed: sql`exists (select 1 from ticket_watchers w
                             where w.ticket_id = t.id and w.user_id = ${actor.id})`,
    // Open question 13 draft: own only; Management and Finance see everything.
    all: actor.role === "MANAGEMENT" || actor.role === "FINANCE_HOD"
      ? sql`true`
      : sql`(t.target_department_id = ${actor.departmentId} or t.requesting_department_id = ${actor.departmentId})`,
  }[view as Exclude<TicketScope, "mine" | "raised">];

  // A board column is a set of statuses, not a status (see CATEGORY_OF).
  const wanted = opts.categories?.length
    ? opts.categories.flatMap(statesIn)
    : opts.status?.length
      ? opts.status
      : null;

  const rows = (await db.execute(sql`
    select t.id, t.human_id, t.title, t.status::text as status, t.priority::text as priority,
           t.due_at, t.escalated_at, t.estimated_cost_paise, t.location,
           t.requesting_department_id, t.target_department_id, t.requester_id, t.assignee_id,
           t.parent_id, t.project_id, t.cycle_id,
           rq.name as requesting_department, tg.name as target_department,
           ru.name as requester, au.name as assignee,
           pj.name as project, cy.name as cycle, pt.human_id as parent_human_id,
           (t.due_at < now() and t.status not in ('CLOSED','REJECTED','CANCELLED')) as overdue,
           extract(epoch from (now() - t.created_at)) / 3600 as age_hours,
           (select count(*) from comments c
             where c.entity_type = 'TICKET' and c.entity_id = t.id) as comment_count,
           (select count(*) from tickets ch
             where ch.parent_id = t.id and ch.deleted_at is null) as child_count,
           (select count(*) from tickets ch
             where ch.parent_id = t.id and ch.deleted_at is null
               and ch.status in ('DONE','CLOSED')) as child_done_count,
           coalesce((
             select json_agg(json_build_object('id', tl.id, 'name', tl.name, 'color', tl.color)
                             order by tl.name)
               from ticket_label_links ll
               join ticket_labels tl on tl.id = ll.label_id
              where ll.ticket_id = t.id
           ), '[]'::json) as labels
      from tickets t
      join departments rq on rq.id = t.requesting_department_id
      join departments tg on tg.id = t.target_department_id
      join users ru on ru.id = t.requester_id
      left join users au on au.id = t.assignee_id
      left join projects pj on pj.id = t.project_id
      left join cycles cy on cy.id = t.cycle_id
      left join tickets pt on pt.id = t.parent_id
     where t.fest_id = ${actor.festId} and t.deleted_at is null
       and ${scopeFilter}
       ${/* `in ${array}` and not `= any(array)`: drizzle renders a JS array as a
             tuple — ($1, $2) — so the cast form asks Postgres to cast a record to
             an array and fails. Both filters below take the same shape. */
         wanted?.length ? sql`and t.status::text in ${wanted}` : sql``}
       ${opts.priority ? sql`and t.priority = ${opts.priority}::ticket_priority` : sql``}
       ${opts.overdue ? sql`and t.due_at < now() and t.status not in ('CLOSED','REJECTED','CANCELLED')` : sql``}
       ${opts.escalated ? sql`and t.escalated_at is not null` : sql``}
       ${opts.unassigned ? sql`and t.assignee_id is null` : sql``}
       ${opts.parentId ? sql`and t.parent_id = ${opts.parentId}` : sql``}
       ${opts.projectId ? sql`and t.project_id = ${opts.projectId}` : sql``}
       ${opts.cycleId ? sql`and t.cycle_id = ${opts.cycleId}` : sql``}
       ${opts.departmentId
         ? sql`and (t.target_department_id = ${opts.departmentId} or t.requesting_department_id = ${opts.departmentId})`
         : sql``}
       ${opts.assigneeId ? sql`and t.assignee_id = ${opts.assigneeId}` : sql``}
       ${opts.labelIds?.length
         ? sql`and exists (select 1 from ticket_label_links ll
                            where ll.ticket_id = t.id and ll.label_id::text in ${opts.labelIds})`
         : sql``}
       ${opts.q
         ? sql`and (t.title ilike ${`%${opts.q}%`} or t.human_id ilike ${`%${opts.q}%`}
                    or t.description ilike ${`%${opts.q}%`})`
         : sql``}
     order by
       case t.priority when 'URGENT' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 else 3 end,
       t.due_at asc
     limit ${opts.limit ?? 300}
  `)) as unknown as Record<string, unknown>[];

  return rows.map((r) => ({
    id: String(r.id),
    human_id: String(r.human_id),
    title: String(r.title),
    status: String(r.status),
    category: CATEGORY_OF[String(r.status) as TicketState],
    priority: String(r.priority),
    due_at: asDate(r.due_at),
    overdue: Boolean(r.overdue),
    escalated: r.escalated_at !== null,
    age_hours: Math.round(Number(r.age_hours)),
    requesting_department: String(r.requesting_department),
    requesting_department_id: String(r.requesting_department_id),
    target_department: String(r.target_department),
    target_department_id: String(r.target_department_id),
    requester: String(r.requester),
    requester_id: String(r.requester_id),
    assignee: (r.assignee as string) ?? null,
    assignee_id: (r.assignee_id as string) ?? null,
    location: (r.location as string) ?? null,
    estimated_cost_paise: r.estimated_cost_paise === null ? null : Number(r.estimated_cost_paise),
    comment_count: Number(r.comment_count),
    labels: (r.labels as { id: string; name: string; color: string }[]) ?? [],
    project: (r.project as string) ?? null,
    project_id: (r.project_id as string) ?? null,
    cycle: (r.cycle as string) ?? null,
    cycle_id: (r.cycle_id as string) ?? null,
    parent_id: (r.parent_id as string) ?? null,
    parent_human_id: (r.parent_human_id as string) ?? null,
    child_count: Number(r.child_count),
    child_done_count: Number(r.child_done_count),
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
      count(*) filter (where t.requester_id = ${actor.id}
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))          as created,
      count(*) filter (where exists (select 1 from ticket_watchers w
                                      where w.ticket_id = t.id and w.user_id = ${actor.id})
                         and t.status not in ('CLOSED','REJECTED','CANCELLED'))          as subscribed,
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
    // `mine` is kept under its old name for the counts endpoint's existing callers.
    mine: Number(row.mine), assigned: Number(row.mine),
    created: Number(row.created), subscribed: Number(row.subscribed),
    awaitingMyConfirmation: Number(row.awaiting_my_confirmation),
    overdue: Number(row.overdue),
  };
}

/* ------------------------------------------------------ edits and extras (20.9) */

export interface UpdateTicketInput {
  title?: string;
  description?: string;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  dueAt?: string;
  assigneeId?: string | null;
  location?: string | null;
  estimatedCostPaise?: number | null;
  /** Planning: filing a ticket, not deciding it. See the note in `updateTicket`. */
  labelIds?: string[];
  projectId?: string | null;
  cycleId?: string | null;
  parentId?: string | null;
}

/**
 * PRD 20.9 — three different edits behind one endpoint.
 *
 * The requester may correct what they asked for, but only while nobody has started
 * on it (OPEN or NEEDS_INFO). The target HOD may change how the work is scheduled —
 * priority, due date, assignee, location — at any point, because that is triage and
 * it continues after work begins. Neither may do the other's half.
 *
 * Planning fields — labels, project, cycle, parent — are the third kind, and answer
 * to neither rule. They say nothing about what was asked or who owes it; they are
 * filing. So anyone actually on the ticket may set them: the requester, the
 * assignee, or whoever triages it. Gating them behind triage would mean the person
 * doing the work cannot tag their own ticket, which is how tags die.
 *
 * A due-date or priority change notifies the requester: those are the two fields
 * whose silent change makes people stop trusting the board.
 */
export async function updateTicket(actor: SessionUser, id: string, input: UpdateTicketInput) {
  return db.transaction(async (tx) => {
    const before = await load(tx, actor, id);

    const resource = {
      festId: actor.festId,
      departmentId: before.requestingDepartmentId,
      requestingDepartmentId: before.requestingDepartmentId,
      targetDepartmentId: before.targetDepartmentId,
      requesterId: before.requesterId,
      submitterId: before.requesterId,
      assigneeId: before.assigneeId ?? undefined,
    };

    const isRequester = before.requesterId === actor.id;
    const canTriage = (() => {
      try {
        assertCan(actor, "ticket.triage", resource);
        return true;
      } catch {
        return false;
      }
    })();

    const asksRequesterFields = input.title !== undefined || input.description !== undefined;
    const asksTriageFields =
      input.priority !== undefined || input.dueAt !== undefined ||
      input.assigneeId !== undefined || input.location !== undefined ||
      input.estimatedCostPaise !== undefined;
    const asksPlanningFields =
      input.labelIds !== undefined || input.projectId !== undefined ||
      input.cycleId !== undefined || input.parentId !== undefined;

    if (asksRequesterFields) {
      if (!isRequester) {
        throw new ApiError("FORBIDDEN", "Only the person who raised a ticket can reword it");
      }
      if (before.status !== "OPEN" && before.status !== "NEEDS_INFO") {
        throw new ApiError("VALIDATION_ERROR",
          "A ticket can only be reworded before it is accepted; add a comment instead");
      }
    }
    if (asksTriageFields && !canTriage) {
      throw new ApiError("FORBIDDEN", "Only the target department's HOD can retriage a ticket");
    }
    if (asksPlanningFields && !isRequester && !canTriage && before.assigneeId !== actor.id) {
      throw new ApiError("FORBIDDEN", "Only somebody on this ticket can file it under a project or label");
    }
    if (!asksRequesterFields && !asksTriageFields && !asksPlanningFields) {
      throw new ApiError("VALIDATION_ERROR", "Nothing to change");
    }
    if (input.parentId && input.parentId === id) {
      throw new ApiError("VALIDATION_ERROR", "A ticket cannot be its own parent");
    }
    await assertPlanningRefs(tx, actor, input, id);

    if (input.assigneeId) {
      // An assignee has to be someone in the department doing the work.
      const [assignee] = await tx.select({ id: users.id }).from(users).where(and(
        eq(users.id, input.assigneeId),
        eq(users.festId, actor.festId),
        eq(users.departmentId, before.targetDepartmentId),
        eq(users.status, "ACTIVE"),
      )).limit(1);
      if (!assignee) {
        throw new ApiError("VALIDATION_ERROR", "The assignee must be an active member of the target department");
      }
    }

    const [after] = await tx.update(tickets).set({
      title: input.title ?? before.title,
      description: input.description ?? before.description,
      priority: input.priority ?? before.priority,
      dueAt: input.dueAt ? new Date(input.dueAt) : before.dueAt,
      assigneeId: input.assigneeId === undefined ? before.assigneeId : input.assigneeId,
      location: input.location === undefined ? before.location : input.location,
      estimatedCostPaise: input.estimatedCostPaise === undefined
        ? before.estimatedCostPaise : input.estimatedCostPaise,
      projectId: input.projectId === undefined ? before.projectId : input.projectId,
      cycleId: input.cycleId === undefined ? before.cycleId : input.cycleId,
      parentId: input.parentId === undefined ? before.parentId : input.parentId,
      updatedAt: new Date(),
    }).where(eq(tickets.id, id)).returning();

    if (input.labelIds !== undefined) await setLabels(tx, id, input.labelIds);

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET", entityId: id, actorId: actor.id,
      action: "ticket.update",
      before: snapshot(before, AUDITED), after: snapshot(after, AUDITED),
    });

    const dueChanged = input.dueAt && after.dueAt.getTime() !== before.dueAt.getTime();
    const priorityChanged = input.priority && input.priority !== before.priority;
    if (dueChanged || priorityChanged) {
      await notify(tx, {
        festId: actor.festId, type: "ticket.retriaged", entityType: "TICKET", entityId: id,
        title: `${after.humanId}: ${dueChanged ? "due date" : "priority"} changed`,
        body: `${after.title} — now ${after.priority}, due ${after.dueAt.toISOString().slice(0, 10)}`,
        toUsers: [before.requesterId, ...(after.assigneeId ? [after.assigneeId] : [])],
        exceptUserId: actor.id,
      });
    }

    return after;
  });
}

/** PRD 20.9 — watch or unwatch. Anyone who can see the ticket can watch it. */
export async function setWatcher(actor: SessionUser, ticketId: string, userId: string, watching: boolean) {
  return db.transaction(async (tx) => {
    const ticket = await load(tx, actor, ticketId);

    // You may always watch on your own behalf; adding somebody else is triage.
    if (userId !== actor.id) {
      assertCan(actor, "ticket.triage", {
        festId: actor.festId,
        targetDepartmentId: ticket.targetDepartmentId,
        requestingDepartmentId: ticket.requestingDepartmentId,
      });
    }

    if (watching) {
      await tx.insert(ticketWatchers).values({ ticketId, userId }).onConflictDoNothing();
    } else {
      await tx.delete(ticketWatchers).where(and(
        eq(ticketWatchers.ticketId, ticketId),
        eq(ticketWatchers.userId, userId),
      ));
    }
    return { ticket_id: ticketId, user_id: userId, watching };
  });
}

export type LinkableType = "REIMBURSEMENT" | "VENDOR_REQUEST" | "TICKET";

/**
 * PRD 20.9 — relate a ticket to the money it caused, or to a sibling ticket.
 * "Stage needs a generator" and the ₹40,000 vendor request for one are the same
 * fact; linking them is how the close-out report reconciles.
 */
export async function linkTicket(actor: SessionUser, ticketId: string, toType: LinkableType, toId: string) {
  return db.transaction(async (tx) => {
    await load(tx, actor, ticketId);
    if (toType === "TICKET" && toId === ticketId) {
      throw new ApiError("VALIDATION_ERROR", "A ticket cannot be linked to itself");
    }

    // The target has to exist in this fest and be something the caller can see.
    const { resolveEntity } = await import("@/lib/entities");
    const { can } = await import("@/lib/authz");
    const { VIEW_ACTION } = await import("@/lib/entities");
    const target = await resolveEntity(actor.festId, toType, toId, tx);
    if (!can(actor, VIEW_ACTION[toType], target)) {
      throw new ApiError("FORBIDDEN", "You cannot see the record you are linking to");
    }

    const [row] = await tx.insert(entityLinks).values({
      festId: actor.festId,
      fromType: "TICKET", fromId: ticketId,
      toType, toId,
      createdBy: actor.id,
    }).onConflictDoNothing().returning();

    if (row) {
      await recordAudit(tx, {
        festId: actor.festId, entityType: "TICKET", entityId: ticketId, actorId: actor.id,
        action: "ticket.link", after: { to_type: toType, to_id: toId },
      });
    }
    return row ?? { already_linked: true };
  });
}

/**
 * PRD 20.9 — up to five open tickets with similar titles, shown while someone is
 * typing a new one. Half the tickets raised during a fest are the same ask twice;
 * this is the cheapest place to catch that.
 *
 * Trigram similarity, so "genrator for stage" still finds "Generator for main stage".
 */
export async function similarTickets(actor: Actor, targetDepartmentId: string, title: string) {
  if (title.trim().length < 4) return [];

  return (await db.execute(sql`
    select t.id, t.human_id, t.title, t.status::text as status, t.priority::text as priority,
           t.due_at, u.name as requester, d.name as requesting_department,
           similarity(t.title, ${title}) as score
      from tickets t
      join users u on u.id = t.requester_id
      join departments d on d.id = t.requesting_department_id
     where t.fest_id = ${actor.festId} and t.deleted_at is null
       and t.target_department_id = ${targetDepartmentId}
       and t.status not in ('CLOSED','REJECTED','CANCELLED')
       and similarity(t.title, ${title}) > 0.25
     order by score desc, t.created_at desc
     limit 5
  `)) as unknown as Record<string, unknown>[];
}

/**
 * PRD 20.9 — counts by department × priority × status, plus overdue and escalated.
 * Management's picture of where the fest is straining; an HOD sees their own column.
 */
export async function ticketWorkload(actor: Actor) {
  assertCan(actor, "ticket.view", {
    festId: actor.festId,
    targetDepartmentId: actor.departmentId,
    requestingDepartmentId: actor.departmentId,
  });
  const festWide = actor.role === "MANAGEMENT" || actor.role === "FINANCE_HOD";

  const rows = (await db.execute(sql`
    select d.id as department_id, d.name as department,
           t.priority::text as priority, t.status::text as status,
           count(*)::int as n,
           count(*) filter (where t.due_at < now()
                              and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as overdue,
           count(*) filter (where t.escalated_at is not null
                              and t.status not in ('CLOSED','REJECTED','CANCELLED'))::int as escalated
      from tickets t
      join departments d on d.id = t.target_department_id
     where t.fest_id = ${actor.festId} and t.deleted_at is null
       ${festWide ? sql`` : sql`and t.target_department_id = ${actor.departmentId}`}
     group by d.id, d.name, t.priority, t.status
     order by d.name, t.priority
  `)) as unknown as Record<string, unknown>[];

  const totals = rows.reduce<{ tickets: number; overdue: number; escalated: number }>(
    (acc, r) => ({
      tickets: acc.tickets + Number(r.n),
      overdue: acc.overdue + Number(r.overdue),
      escalated: acc.escalated + Number(r.escalated),
    }),
    { tickets: 0, overdue: 0, escalated: 0 },
  );

  return { rows, totals };
}
