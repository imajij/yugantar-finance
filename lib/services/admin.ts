/**
 * People, expense types and fest settings (PRD 20.10). Small surface, same rules:
 * one transaction, audit inside it, soft delete only.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, expenseTypes, fests, users } from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, type Actor } from "@/lib/authz";
import { requestSignInLink, revokeAllSessions } from "@/lib/auth";
import { clerkConfigured, emailDomainAllowed, revokeClerkSessions, sendClerkInvitation } from "@/lib/clerk";
import type { Role } from "@/lib/state-machines/types";
import { recordAudit, snapshot } from "./audit";

const USER_AUDITED = ["name", "email", "role", "departmentId", "status", "upiId"] as const;

export interface UserInput {
  name: string;
  email: string;
  role: Role;
  departmentId: string;
  upiId?: string | null;
  phone?: string | null;
}

/**
 * A fest has exactly one Finance HOD and one Management account (5.1). Promoting
 * someone into either seat is allowed; ending up with two is not.
 */
async function assertSeatFree(festId: string, role: Role, exceptUserId?: string) {
  if (role !== "FINANCE_HOD" && role !== "MANAGEMENT") return;
  const [row] = await db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(users)
    .where(and(
      eq(users.festId, festId),
      eq(users.role, role),
      sql`${users.status} <> 'DISABLED'`,
      exceptUserId ? sql`${users.id} <> ${exceptUserId}` : undefined,
    ));
  if ((row?.n ?? 0) > 0) {
    throw conflict(`This fest already has a ${role.replace("_", " ").toLowerCase()}`);
  }
}

export async function inviteUser(actor: Actor, input: UserInput) {
  assertCan(actor, "user.manage", { festId: actor.festId });
  await assertSeatFree(actor.festId, input.role);

  // 13: college domain, with invited external Management users as the exception.
  if (!emailDomainAllowed(input.email) && input.role !== "MANAGEMENT") {
    throw new ApiError(
      "VALIDATION_ERROR",
      `Only @${process.env.ALLOWED_EMAIL_DOMAIN} addresses can be invited, except for Management`,
    );
  }

  const row = await db.transaction(async (tx) => {
    const [dept] = await tx.select({ id: departments.id }).from(departments)
      .where(and(eq(departments.id, input.departmentId), eq(departments.festId, actor.festId))).limit(1);
    if (!dept) throw notFound("Department");

    const existing = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.festId, actor.festId), eq(users.email, input.email))).limit(1);
    if (existing.length) throw conflict("Someone with that email is already on this fest");

    const [row] = await tx.insert(users).values({
      festId: actor.festId,
      name: input.name,
      email: input.email,
      role: input.role,
      departmentId: input.departmentId,
      upiId: input.upiId ?? null,
      phone: input.phone ?? null,
      status: "INVITED",
    }).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "USER", entityId: row.id, actorId: actor.id,
      action: "user.invite", after: snapshot(row, USER_AUDITED),
    });
    return row;
  });

  // Outside the transaction: a mail failure must not undo an invitation the Finance
  // HOD can re-send from the admin screen.
  //
  // Which invitation depends on how people sign in (`lib/session.ts`). With Clerk it
  // is Clerk's own; without it, the same one-time link the sign-in page issues —
  // arriving unprompted is the difference between an invitation and a row in a table.
  const invited = clerkConfigured()
    ? await sendClerkInvitation(row.email)
    : await requestSignInLink({ email: row.email }).then(() => true, () => false);

  return { ...row, invitation_sent: invited };
}

export async function updateUser(
  actor: Actor, id: string,
  input: Partial<Pick<UserInput, "name" | "role" | "departmentId" | "upiId" | "phone">> & { status?: "ACTIVE" | "DISABLED" },
) {
  assertCan(actor, "user.manage", { festId: actor.festId });
  if (input.role) await assertSeatFree(actor.festId, input.role, id);

  const updated = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(users)
      .where(and(eq(users.id, id), eq(users.festId, actor.festId))).limit(1);
    if (!before) throw notFound("User");

    // Locking yourself out is the one mistake nobody can undo from inside the app.
    if (id === actor.id && (input.status === "DISABLED" || (input.role && input.role !== before.role))) {
      throw new ApiError("VALIDATION_ERROR", "You cannot change your own role or deactivate yourself");
    }

    const [after] = await tx.update(users).set({ ...input, updatedAt: new Date() })
      .where(eq(users.id, id)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "USER", entityId: id, actorId: actor.id,
      action: "user.update", before: snapshot(before, USER_AUDITED), after: snapshot(after, USER_AUDITED),
    });
    return after;
  });

  // Disabling has to reach the session store, or the person keeps working until
  // their cookie expires. `resolveSession` already refuses a DISABLED user, so this
  // is belt and braces — but it also kills any outstanding sign-in links, which
  // nothing else would.
  if (input.status === "DISABLED") {
    await revokeAllSessions(id);
    if (updated.clerkUserId) await revokeClerkSessions(updated.clerkUserId);
  }
  return updated;
}

export async function listUsers(actor: Actor) {
  assertCan(actor, "user.manage", { festId: actor.festId });
  return db
    .select({
      id: users.id, name: users.name, email: users.email, role: users.role,
      status: users.status, upiId: users.upiId, phone: users.phone,
      department: departments.name, departmentId: users.departmentId,
    })
    .from(users).innerJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.festId, actor.festId))
    .orderBy(asc(departments.name), asc(users.name));
}

export async function createExpenseType(actor: Actor, name: string) {
  assertCan(actor, "expenseType.manage", { festId: actor.festId });
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(expenseTypes)
      .values({ festId: actor.festId, name })
      .returning();
    await recordAudit(tx, {
      festId: actor.festId, entityType: "FEST", entityId: actor.festId, actorId: actor.id,
      action: "expense_type.create", after: { name: row.name },
    });
    return row;
  });
}

export async function setExpenseTypeActive(actor: Actor, id: string, isActive: boolean) {
  assertCan(actor, "expenseType.manage", { festId: actor.festId });
  return db.transaction(async (tx) => {
    const [row] = await tx.update(expenseTypes).set({ isActive })
      .where(and(eq(expenseTypes.id, id), eq(expenseTypes.festId, actor.festId)))
      .returning();
    if (!row) throw notFound("Expense type");
    await recordAudit(tx, {
      festId: actor.festId, entityType: "FEST", entityId: actor.festId, actorId: actor.id,
      action: isActive ? "expense_type.activate" : "expense_type.deactivate",
      after: { name: row.name, is_active: isActive },
    });
    return row;
  });
}

/** Flag thresholds and fest dates (8.2, 20.10). Merged, so a partial patch is safe. */
export async function updateFestSettings(actor: Actor, patch: Record<string, unknown>) {
  assertCan(actor, "fest.manage", { festId: actor.festId });
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(fests).where(eq(fests.id, actor.festId)).limit(1);
    if (!before) throw notFound("Fest");

    const settings = {
      ...(before.settings as Record<string, unknown>),
      ...patch,
      flag_thresholds: {
        ...((before.settings as Record<string, unknown>).flag_thresholds as Record<string, unknown> ?? {}),
        ...((patch.flag_thresholds as Record<string, unknown>) ?? {}),
      },
    };

    const [after] = await tx.update(fests).set({ settings, updatedAt: new Date() })
      .where(eq(fests.id, actor.festId)).returning();

    await recordAudit(tx, {
      festId: actor.festId, entityType: "FEST", entityId: actor.festId, actorId: actor.id,
      action: "fest.settings.update",
      before: { settings: before.settings }, after: { settings: after.settings },
    });
    return after;
  });
}
