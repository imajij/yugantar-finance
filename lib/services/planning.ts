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
 * Tech, because the point of a shared vocabulary is that it is shared. Templates,
 * added later, follow the same rule for the same reason.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/db";
import {
  cycles, departments, projects, ticketLabels, ticketLabelLinks, ticketTemplateLabels,
  ticketTemplates, tickets, users,
} from "@/db/schema";
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
    // Templates point at cycles too, and this is a hard delete — a template left
    // holding the id would take the whole transaction down on the foreign key.
    await tx.update(ticketTemplates).set({ cycleId: null }).where(eq(ticketTemplates.cycleId, id));
    await tx.delete(cycles).where(eq(cycles.id, id));

    await recordAudit(tx, {
      festId: actor.festId, entityType: "CYCLE", entityId: id, actorId: actor.id,
      action: "cycle.delete", before: { name: before.name },
    });
    return { ok: true };
  });
}

/* ----------------------------------------------------------------- templates */

/**
 * A template is a half-written ticket.
 *
 * It saves typing and nothing else. Choosing one prefills a form; the ticket that
 * comes out still goes through `createTicket`, which is still what decides who may
 * address whom. A template that names Logistics does not let a Member raise with
 * Logistics — the form does not offer it, and the API refuses it if they ask
 * anyway. Worth being explicit about, because "template" is the sort of word that
 * sounds like it might carry authority.
 *
 * Fest-scoped and shared, like labels: a template Logistics wrote for "how to ask
 * us for a van" is exactly the thing Tech should be able to pick up.
 *
 * Retired rather than deleted (`is_active`), so a template that has shaped fifty
 * tickets does not vanish from the record.
 */
export interface TemplateInput {
  name: string;
  summary?: string | null;
  targetDepartmentId?: string | null;
  title?: string | null;
  body?: string | null;
  priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
  location?: string | null;
  estimatedCostPaise?: number | null;
  dueInHours?: number | null;
  projectId?: string | null;
  cycleId?: string | null;
  labelIds?: string[];
}

/**
 * Templates a caller could actually use.
 *
 * A Member may only raise with their own department, so a template addressed
 * anywhere else is not a choice they have — offering it would mean a form that
 * fills itself in and then refuses to submit. Filtered here rather than in the
 * page, so the API and the screen cannot disagree about it.
 */
export async function listTemplates(actor: Actor, opts: { all?: boolean } = {}) {
  const usable = actor.role === "MEMBER"
    ? sql`and (tt.target_department_id is null or tt.target_department_id = ${actor.departmentId})`
    : sql``;

  return (await db.execute(sql`
    select tt.id, tt.name, tt.summary, tt.target_department_id, d.name as target_department,
           tt.title, tt.body, tt.default_priority::text as priority, tt.location,
           tt.estimated_cost_paise, tt.due_in_hours,
           tt.project_id, pj.name as project, tt.cycle_id, cy.name as cycle, tt.is_active,
           coalesce((
             select json_agg(json_build_object('id', l.id, 'name', l.name, 'color', l.color)
                             order by l.name)
               from ticket_template_labels tl
               join ticket_labels l on l.id = tl.label_id
              where tl.template_id = tt.id
           ), '[]'::json) as labels
      from ticket_templates tt
      left join departments d on d.id = tt.target_department_id
      left join projects pj on pj.id = tt.project_id and pj.deleted_at is null
      left join cycles cy on cy.id = tt.cycle_id
     where tt.fest_id = ${actor.festId}
       ${opts.all ? sql`` : sql`and tt.is_active`}
       ${usable}
     order by tt.is_active desc, tt.name
  `)) as unknown as Record<string, unknown>[];
}

export async function createTemplate(actor: Actor, input: TemplateInput) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });
  const name = input.name.trim();
  if (name.length < 2) throw new ApiError("VALIDATION_ERROR", "A template needs a name");

  return db.transaction(async (tx) => {
    const [clash] = await tx.select({ id: ticketTemplates.id }).from(ticketTemplates)
      .where(and(
        eq(ticketTemplates.festId, actor.festId),
        eq(ticketTemplates.isActive, true),
        sql`lower(${ticketTemplates.name}) = lower(${name})`,
      )).limit(1);
    if (clash) throw conflict(`There is already a “${name}” template`);

    await assertTemplateRefs(tx, actor, input);

    const [row] = await tx.insert(ticketTemplates).values({
      festId: actor.festId,
      name,
      summary: input.summary ?? null,
      targetDepartmentId: input.targetDepartmentId ?? null,
      title: input.title ?? null,
      body: input.body ?? null,
      defaultPriority: input.priority ?? "MEDIUM",
      location: input.location ?? null,
      estimatedCostPaise: input.estimatedCostPaise ?? null,
      dueInHours: input.dueInHours ?? null,
      projectId: input.projectId ?? null,
      cycleId: input.cycleId ?? null,
      createdBy: actor.id,
    }).returning();

    await setTemplateLabels(tx, row.id, input.labelIds);
    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET_TEMPLATE", entityId: row.id, actorId: actor.id,
      action: "template.create", after: { name: row.name, target_department_id: row.targetDepartmentId },
    });
    return row;
  });
}

export async function updateTemplate(actor: Actor, id: string, input: Partial<TemplateInput>) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(ticketTemplates)
      .where(and(eq(ticketTemplates.id, id), eq(ticketTemplates.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Template");
    await assertTemplateRefs(tx, actor, input);

    const pick = <T>(next: T | undefined, current: T) => (next === undefined ? current : next);
    const [after] = await tx.update(ticketTemplates).set({
      name: input.name?.trim() ?? before.name,
      summary: pick(input.summary, before.summary),
      targetDepartmentId: pick(input.targetDepartmentId, before.targetDepartmentId),
      title: pick(input.title, before.title),
      body: pick(input.body, before.body),
      defaultPriority: input.priority ?? before.defaultPriority,
      location: pick(input.location, before.location),
      estimatedCostPaise: pick(input.estimatedCostPaise, before.estimatedCostPaise),
      dueInHours: pick(input.dueInHours, before.dueInHours),
      projectId: pick(input.projectId, before.projectId),
      cycleId: pick(input.cycleId, before.cycleId),
      updatedAt: new Date(),
    }).where(eq(ticketTemplates.id, id)).returning();

    if (input.labelIds !== undefined) await setTemplateLabels(tx, id, input.labelIds);
    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET_TEMPLATE", entityId: id, actorId: actor.id,
      action: "template.update",
      before: { name: before.name }, after: { name: after.name },
    });
    return after;
  });
}

/**
 * Retiring a template. Soft, because the tickets it shaped are still in the record
 * and somebody reading the audit log a month later should be able to see what they
 * were filled in from.
 */
export async function retireTemplate(actor: Actor, id: string) {
  assertCan(actor, "ticket.plan", { festId: actor.festId, departmentId: actor.departmentId });

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(ticketTemplates)
      .where(and(eq(ticketTemplates.id, id), eq(ticketTemplates.festId, actor.festId))).limit(1);
    if (!before) throw notFound("Template");

    const [after] = await tx.update(ticketTemplates)
      .set({ isActive: !before.isActive, updatedAt: new Date() })
      .where(eq(ticketTemplates.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "TICKET_TEMPLATE", entityId: id, actorId: actor.id,
      action: after.isActive ? "template.restore" : "template.retire",
      before: { name: before.name, is_active: before.isActive },
      after: { is_active: after.isActive },
    });
    return after;
  });
}

async function setTemplateLabels(tx: Tx, templateId: string, labelIds?: string[]) {
  if (labelIds === undefined) return;
  await tx.delete(ticketTemplateLabels).where(eq(ticketTemplateLabels.templateId, templateId));
  if (labelIds.length === 0) return;
  await tx.insert(ticketTemplateLabels)
    .values([...new Set(labelIds)].map((labelId) => ({ templateId, labelId })))
    .onConflictDoNothing();
}

/**
 * Every id a template points at has to belong to this fest (18.2 rule 10). A UUID
 * is not a secret, and a template is a place somebody could otherwise park a
 * reference to another fest's project and have this one render its name.
 */
async function assertTemplateRefs(tx: Tx, actor: Actor, input: Partial<TemplateInput>) {
  const check = async (id: string | null | undefined, what: string, q: () => Promise<unknown[]>) => {
    if (!id) return;
    if ((await q()).length === 0) throw notFound(what);
  };

  await check(input.targetDepartmentId, "Department", () =>
    tx.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.id, input.targetDepartmentId!), eq(departments.festId, actor.festId)))
      .limit(1));
  await check(input.projectId, "Project", () =>
    tx.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, input.projectId!), eq(projects.festId, actor.festId), isNull(projects.deletedAt)))
      .limit(1));
  await check(input.cycleId, "Cycle", () =>
    tx.select({ id: cycles.id }).from(cycles)
      .where(and(eq(cycles.id, input.cycleId!), eq(cycles.festId, actor.festId)))
      .limit(1));

  if (input.labelIds?.length) {
    const found = await tx.select({ id: ticketLabels.id }).from(ticketLabels)
      .where(and(eq(ticketLabels.festId, actor.festId), inArray(ticketLabels.id, input.labelIds)));
    if (found.length !== new Set(input.labelIds).size) throw notFound("Label");
  }
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
