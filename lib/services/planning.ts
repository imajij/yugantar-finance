/**
 * Labels, projects and cycles — the axes a ticket board is sliced by.
 *
 * None of these change what a ticket *is*, which is why they live apart from the
 * state machine and carry no permissions of their own beyond `ticket.plan`. A label
 * is a tag; a project groups tickets toward a deliverable ("Main stage build"); a
 * cycle is a fixed window everyone plans against ("Setup week", "Fest days"). They
 * exist so a board can answer "what is left for the main stage" and "what is due
 * this week" without either question becoming a status.
 *
 * All three are fest-scoped and shared: a label made by Logistics is usable by
 * Tech, because the point of a shared vocabulary is that it is shared.
 */
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { cycles, projects, ticketLabels, ticketLabelLinks, tickets, users } from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, type Actor } from "@/lib/authz";
import { recordAudit } from "./audit";

const HEX = /^#[0-9a-fA-F]{6}$/;

/* ------------------------------------------------------------------- labels */

export async function listLabels(actor: Actor) {
  const rows = await db.select({
    id: ticketLabels.id, name: ticketLabels.name, color: ticketLabels.color,
  }).from(ticketLabels)
    .where(eq(ticketLabels.festId, actor.festId))
    .orderBy(asc(ticketLabels.name));

  const counts = (await db.execute<{ label_id: string; n: number }>(sql`
    select l.label_id, count(*)::int as n
      from ticket_label_links l
      join tickets t on t.id = l.ticket_id
     where t.fest_id = ${actor.festId} and t.deleted_at is null
     group by l.label_id
  `)) as unknown as { label_id: string; n: number }[];
  const by = new Map(counts.map((c) => [c.label_id, Number(c.n)]));

  return rows.map((r) => ({ ...r, ticket_count: by.get(r.id) ?? 0 }));
}

export async function createLabel(actor: Actor, input: { name: string; color?: string }) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });
  const name = input.name.trim();
  if (name.length < 2) throw new ApiError("VALIDATION_ERROR", "A label needs a name");
  if (input.color && !HEX.test(input.color)) {
    throw new ApiError("VALIDATION_ERROR", "A colour must be a six-digit hex like #d2fc3c");
  }

  return db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: ticketLabels.id }).from(ticketLabels)
      .where(and(eq(ticketLabels.festId, actor.festId), sql`lower(${ticketLabels.name}) = lower(${name})`))
      .limit(1);
    if (existing) throw conflict(`There is already a “${name}” label`);

    const [row] = await tx.insert(ticketLabels).values({
      festId: actor.festId, name, color: input.color ?? "#8b8ba7", createdBy: actor.id,
    }).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET_LABEL", entityId: row.id, actorId: actor.id,
      action: "label.create", after: { name: row.name, color: row.color },
    });
    return row;
  });
}

export async function updateLabel(actor: Actor, id: string, input: { name?: string; color?: string }) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });
  if (input.color && !HEX.test(input.color)) {
    throw new ApiError("VALIDATION_ERROR", "A colour must be a six-digit hex like #d2fc3c");
  }

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(ticketLabels)
      .where(and(eq(ticketLabels.id, id), eq(ticketLabels.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Label");

    const [after] = await tx.update(ticketLabels).set({
      name: input.name?.trim() ?? before.name,
      color: input.color ?? before.color,
    }).where(eq(ticketLabels.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET_LABEL", entityId: id, actorId: actor.id,
      action: "label.update",
      before: { name: before.name, color: before.color },
      after: { name: after.name, color: after.color },
    });
    return after;
  });
}

/**
 * Labels are the one thing here that is genuinely deleted rather than soft-deleted.
 * Rule 7's soft-delete exists to keep a financial record readable years later; a
 * tag carries no such record, and a permanently retired tag that still shows in
 * every filter is worse than gone. The links go with it, by cascade.
 */
export async function deleteLabel(actor: Actor, id: string) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(ticketLabels)
      .where(and(eq(ticketLabels.id, id), eq(ticketLabels.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Label");

    await tx.delete(ticketLabelLinks).where(eq(ticketLabelLinks.labelId, id));
    await tx.delete(ticketLabels).where(eq(ticketLabels.id, id));

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET_LABEL", entityId: id, actorId: actor.id,
      action: "label.delete", before: { name: before.name, color: before.color },
    });
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ projects */

export async function listProjects(actor: Actor) {
  return (await db.execute(sql`
    select p.id, p.name, p.description, p.status::text as status,
           p.starts_on, p.ends_on, u.name as lead_name, p.lead_id,
           count(t.id) filter (where t.deleted_at is null)::int                     as ticket_count,
           count(t.id) filter (where t.deleted_at is null
             and t.status in ('DONE','CLOSED'))::int                                as done_count
      from projects p
      left join users u on u.id = p.lead_id
      left join tickets t on t.project_id = p.id
     where p.fest_id = ${actor.festId} and p.deleted_at is null
     group by p.id, u.name
     order by (p.status = 'ACTIVE') desc, p.starts_on nulls last, p.name
  `)) as unknown as Record<string, unknown>[];
}

export interface ProjectInput {
  name: string;
  description?: string | null;
  status?: "PLANNED" | "ACTIVE" | "COMPLETED" | "CANCELLED";
  leadId?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

export async function createProject(actor: Actor, input: ProjectInput) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });
  const name = input.name.trim();
  if (name.length < 2) throw new ApiError("VALIDATION_ERROR", "A project needs a name");
  assertRange(input.startsOn, input.endsOn);

  return db.transaction(async (tx) => {
    await assertLead(tx, actor, input.leadId);
    const [row] = await tx.insert(projects).values({
      festId: actor.festId,
      name,
      description: input.description ?? null,
      status: input.status ?? "PLANNED",
      leadId: input.leadId ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      createdBy: actor.id,
    }).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "PROJECT", entityId: row.id, actorId: actor.id,
      action: "project.create", after: { name: row.name, status: row.status },
    });
    return row;
  });
}

export async function updateProject(actor: Actor, id: string, input: Partial<ProjectInput>) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(projects)
      .where(and(eq(projects.id, id), eq(projects.festId, actor.festId), isNull(projects.deletedAt)))
      .limit(1);
    if (!before) throw notFound("Project");
    await assertLead(tx, actor, input.leadId);
    assertRange(input.startsOn ?? before.startsOn, input.endsOn ?? before.endsOn);

    const [after] = await tx.update(projects).set({
      name: input.name?.trim() ?? before.name,
      description: input.description === undefined ? before.description : input.description,
      status: input.status ?? before.status,
      leadId: input.leadId === undefined ? before.leadId : input.leadId,
      startsOn: input.startsOn === undefined ? before.startsOn : input.startsOn,
      endsOn: input.endsOn === undefined ? before.endsOn : input.endsOn,
      updatedAt: new Date(),
    }).where(eq(projects.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "PROJECT", entityId: id, actorId: actor.id,
      action: "project.update",
      before: { name: before.name, status: before.status },
      after: { name: after.name, status: after.status },
    });
    return after;
  });
}

/**
 * Retiring a project. Soft, and the tickets survive it — a project is a grouping,
 * not an owner, so removing it must never take work off anybody's board. They are
 * simply unfiled.
 */
export async function deleteProject(actor: Actor, id: string) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(projects)
      .where(and(eq(projects.id, id), eq(projects.festId, actor.festId), isNull(projects.deletedAt)))
      .limit(1);
    if (!before) throw notFound("Project");

    await tx.update(tickets).set({ projectId: null }).where(eq(tickets.projectId, id));
    await tx.update(projects).set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(projects.id, id));

    await recordAudit(tx, {
      festId: actor.festId, entityType: "PROJECT", entityId: id, actorId: actor.id,
      action: "project.delete", before: { name: before.name },
    });
    return { ok: true };
  });
}

/* -------------------------------------------------------------------- cycles */

export async function listCycles(actor: Actor) {
  return (await db.execute(sql`
    select c.id, c.name, c.starts_on, c.ends_on,
           (current_date between c.starts_on and c.ends_on) as is_current,
           count(t.id) filter (where t.deleted_at is null)::int                     as ticket_count,
           count(t.id) filter (where t.deleted_at is null
             and t.status in ('DONE','CLOSED'))::int                                as done_count
      from cycles c
      left join tickets t on t.cycle_id = c.id
     where c.fest_id = ${actor.festId}
     group by c.id
     order by c.starts_on
  `)) as unknown as Record<string, unknown>[];
}

export async function createCycle(actor: Actor, input: { name: string; startsOn: string; endsOn: string }) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });
  const name = input.name.trim();
  if (name.length < 2) throw new ApiError("VALIDATION_ERROR", "A cycle needs a name");
  if (input.endsOn < input.startsOn) {
    throw new ApiError("VALIDATION_ERROR", "A cycle cannot end before it starts");
  }

  return db.transaction(async (tx) => {
    const [row] = await tx.insert(cycles).values({
      festId: actor.festId, name, startsOn: input.startsOn, endsOn: input.endsOn, createdBy: actor.id,
    }).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CYCLE", entityId: row.id, actorId: actor.id,
      action: "cycle.create", after: { name: row.name, starts_on: row.startsOn, ends_on: row.endsOn },
    });
    return row;
  });
}

export async function deleteCycle(actor: Actor, id: string) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(cycles)
      .where(and(eq(cycles.id, id), eq(cycles.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Cycle");

    await tx.update(tickets).set({ cycleId: null }).where(eq(tickets.cycleId, id));
    await tx.delete(cycles).where(eq(cycles.id, id));

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CYCLE", entityId: id, actorId: actor.id,
      action: "cycle.delete", before: { name: before.name },
    });
    return { ok: true };
  });
}

/* -------------------------------------------------------------------- shared */

function assertRange(startsOn?: string | null, endsOn?: string | null) {
  if (startsOn && endsOn && endsOn < startsOn) {
    throw new ApiError("VALIDATION_ERROR", "The end date cannot be before the start date");
  }
}

async function assertLead(tx: Parameters<typeof recordAudit>[0], actor: Actor, leadId?: string | null) {
  if (!leadId) return;
  const [lead] = await tx.select({ id: users.id }).from(users)
    .where(and(eq(users.id, leadId), eq(users.festId, actor.festId), eq(users.status, "ACTIVE")))
    .limit(1);
  // A UUID is not a secret: the lead has to be somebody in this fest (18.2 rule 10).
  if (!lead) throw notFound("Project lead");
}
