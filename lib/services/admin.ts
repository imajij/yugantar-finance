/**
 * People, expense types and fest settings (PRD 20.10). Small surface, same rules:
 * one transaction, audit inside it, soft delete only.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, expenseTypes, fests, users } from "@/db/schema";
import { ApiError, conflict, notFound } from "@/lib/api";
import { assertCan, can, canFestWide, type Actor } from "@/lib/authz";
import { requestSignInLink, revokeAllSessions } from "@/lib/auth";
import { enforce } from "@/lib/rate-limit";
import {
  allowedEmailDomains, clerkConfigured, emailDomainAllowed, revokeClerkSessions, sendClerkInvitation,
} from "@/lib/clerk";
import type { Role } from "@/lib/state-machines/types";
import { recordAudit, snapshot } from "./audit";
import { ensureDepartmentChannel, removeFromAllChannels, syncMembershipForUser } from "./chat";

const USER_AUDITED = ["name", "email", "role", "departmentId", "status", "upiId", "isSuperAdmin"] as const;

export interface UserInput {
  name: string;
  email: string;
  role: Role;
  departmentId: string;
  upiId?: string | null;
  phone?: string | null;
  isSuperAdmin?: boolean;
}

/**
 * Only an administrator may appoint another, and only an administrator may take the
 * flag away. Any other rule and it draws no boundary: if a Finance HOD could grant
 * it, everyone who could reach the admin screen could read the audit log by first
 * making themselves able to.
 */
function assertMaySetSuperAdmin(actor: Actor, wanted: boolean | undefined, current = false) {
  if (wanted === undefined || wanted === current) return;
  assertCan(actor, "superAdmin.manage", { festId: actor.festId });
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

/**
 * What a department head may do to a person, as opposed to what Finance may.
 *
 * A head runs their own team and nothing else. Expressed as one function because
 * the three call sites below would otherwise each need to remember four rules, and
 * the one that forgot would be the way in.
 *
 * Their limits, and why each is there:
 *   - **their own department only** — otherwise a head could take another
 *     department's people, or read a list that is not theirs;
 *   - **members only, in and out** — a head who could appoint another head could
 *     appoint their own endorser, which is 5.2 undone from the inside;
 *   - **no role changes and no department moves** — both are promotions in
 *     disguise, and both belong to Finance;
 *   - **never themselves** — the one mistake nobody can undo from inside the app.
 */
function assertMayManage(
  actor: Actor,
  target: { id?: string; role: Role; departmentId: string; isSuperAdmin?: boolean },
  wanted?: { role?: Role; departmentId?: string; isSuperAdmin?: boolean },
) {
  // Finance and administrators go through the wider door and skip all of this.
  if (can(actor, "user.manage", { festId: actor.festId })) return;

  assertCan(actor, "user.manageOwnTeam", { festId: actor.festId, departmentId: target.departmentId });

  // Checked before the role rule below, or a head editing their own row would be
  // told "roles are Finance's to set" — true of the row, and not the reason.
  if (target.id && target.id === actor.id) {
    throw new ApiError("VALIDATION_ERROR", "You cannot change your own account");
  }
  if (target.role !== "MEMBER") {
    throw new ApiError(
      "FORBIDDEN",
      "A department head manages the members of their department. Roles are Finance's to set.",
    );
  }
  if (wanted?.role !== undefined && wanted.role !== target.role) {
    throw new ApiError("FORBIDDEN", "Changing somebody's role is Finance's to do");
  }
  if (wanted?.departmentId !== undefined && wanted.departmentId !== target.departmentId) {
    throw new ApiError("FORBIDDEN", "Moving somebody between departments is Finance's to do");
  }
  if (wanted?.isSuperAdmin !== undefined && wanted.isSuperAdmin !== target.isSuperAdmin) {
    throw new ApiError("FORBIDDEN", "Only an administrator appoints another");
  }
}

export async function inviteUser(actor: Actor, input: UserInput) {
  assertMayManage(
    actor,
    { role: input.role, departmentId: input.departmentId },
    { isSuperAdmin: input.isSuperAdmin || undefined },
  );
  assertMaySetSuperAdmin(actor, input.isSuperAdmin);
  await assertSeatFree(actor.festId, input.role);

  // 13: college domain, with invited external Management users as the exception.
  if (!emailDomainAllowed(input.email) && input.role !== "MANAGEMENT") {
    throw new ApiError(
      "VALIDATION_ERROR",
      `Only @${allowedEmailDomains().join(" or @")} addresses can be invited, except for Management`,
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
      isSuperAdmin: input.isSuperAdmin ?? false,
      status: "INVITED",
    }).returning();

    // Their department's channel is waiting for them the moment they sign in, not
    // the next time something happens to sweep memberships.
    await ensureDepartmentChannel(tx, actor.festId, dept.id, actor.id);
    await syncMembershipForUser(tx, actor.festId, row.id, dept.id);

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

/**
 * Sending somebody's invitation again.
 *
 * The one that actually needed building: a segregated workflow deadlocks on an
 * empty seat (see `lib/queries/stalled.ts`), and the commonest reason a seat is
 * empty is an invitation that went to spam. Until now the only way out was to
 * delete the account and invite it again, which loses the id every audit row
 * already points at.
 *
 * It is the same message `inviteUser` sends, not a different one — Clerk's own
 * invitation where Clerk is configured, otherwise the one-time sign-in link. An
 * ACTIVE account can be sent one too: "I cannot get in" is the same problem from
 * the other side, and it is a link to *their* address, so it grants nobody
 * anything they did not already have.
 */
export async function resendInvitation(actor: Actor, id: string) {
  const [target] = await db.select({
    id: users.id, name: users.name, email: users.email, status: users.status,
    role: users.role, departmentId: users.departmentId,
  }).from(users)
    .where(and(eq(users.id, id), eq(users.festId, actor.festId))).limit(1);
  // Existence in *this* fest first: answering anything else to somebody holding
  // another fest's user id would describe our fest to an outsider.
  if (!target) throw notFound("User");

  // Sending somebody their own invitation again is not a change to their account,
  // so a head may do it for their own people without the self-check.
  assertMayManage(actor, { role: target.role, departmentId: target.departmentId });

  if (target.status === "DISABLED") {
    throw new ApiError("VALIDATION_ERROR", "That account is deactivated. Reactivate it first.");
  }

  // Invitations send real email from our domain, so they share the invite ceiling.
  await enforce("invite", actor.id);

  // Outside any transaction, and audited before the send: a mail provider failing
  // must not roll back the record that somebody tried.
  await db.transaction(async (tx) => {
    await recordAudit(tx, {
      festId: actor.festId, entityType: "USER", entityId: id, actorId: actor.id,
      action: "user.invite.resend",
      after: { email: target.email, status: target.status },
    });
  });

  const sent = clerkConfigured()
    ? await sendClerkInvitation(target.email)
    : await requestSignInLink({ email: target.email }).then(() => true, () => false);

  return { id: target.id, email: target.email, invitation_sent: sent };
}

export async function updateUser(
  actor: Actor, id: string,
  input: Partial<Pick<UserInput, "name" | "role" | "departmentId" | "upiId" | "phone" | "isSuperAdmin">>
    & { status?: "ACTIVE" | "DISABLED" },
) {
  // Existence in *this* fest is settled first. Checking the seat first would answer
  // "this fest already has a finance hod" to somebody holding another fest's user id —
  // a refusal, but one that describes our fest to an outsider.
  const [target] = await db.select({
    id: users.id, role: users.role, departmentId: users.departmentId, isSuperAdmin: users.isSuperAdmin,
  }).from(users)
    .where(and(eq(users.id, id), eq(users.festId, actor.festId))).limit(1);
  if (!target) throw notFound("User");

  assertMayManage(actor, target, {
    role: input.role, departmentId: input.departmentId, isSuperAdmin: input.isSuperAdmin,
  });

  if (input.role) await assertSeatFree(actor.festId, input.role, id);

  const updated = await db.transaction(async (tx) => {
    const [before] = await tx.select().from(users)
      .where(and(eq(users.id, id), eq(users.festId, actor.festId))).limit(1);
    if (!before) throw notFound("User");

    assertMaySetSuperAdmin(actor, input.isSuperAdmin, before.isSuperAdmin);

    // Locking yourself out is the one mistake nobody can undo from inside the app.
    if (id === actor.id && (input.status === "DISABLED" || (input.role && input.role !== before.role))) {
      throw new ApiError("VALIDATION_ERROR", "You cannot change your own role or deactivate yourself");
    }

    // Nor can the last administrator remove the flag — from themselves or anyone
    // else. A fest with none has nobody who can appoint one, and no way back in to
    // the audit log short of a database console.
    const losingAdmin = before.isSuperAdmin
      && (input.isSuperAdmin === false || input.status === "DISABLED");
    if (losingAdmin) {
      const [{ others }] = (await tx.execute<{ others: number }>(sql`
        select count(*)::int as others from users
         where fest_id = ${actor.festId} and is_super_admin
           and status <> 'DISABLED' and id <> ${id}
      `)) as unknown as { others: number }[];
      if (Number(others) === 0) {
        throw new ApiError(
          "VALIDATION_ERROR",
          "This is the only administrator. Appoint another before removing this one.",
        );
      }
    }

    if (input.departmentId && input.departmentId !== before.departmentId) {
      const [dept] = await tx.select({ id: departments.id }).from(departments)
        .where(and(eq(departments.id, input.departmentId), eq(departments.festId, actor.festId))).limit(1);
      if (!dept) throw notFound("Department");
    }

    const [after] = await tx.update(users).set({ ...input, updatedAt: new Date() })
      .where(eq(users.id, id)).returning();

    // Channel membership follows the department, or moving somebody out of Tech
    // leaves them reading Tech — quietly, with nothing anywhere that would notice.
    if (after.status === "DISABLED") {
      await removeFromAllChannels(tx, actor.festId, id);
    } else if (after.departmentId !== before.departmentId || before.status === "DISABLED") {
      await ensureDepartmentChannel(tx, actor.festId, after.departmentId, actor.id);
      await syncMembershipForUser(tx, actor.festId, id, after.departmentId);
    }

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

/**
 * Everyone the caller may manage: the whole fest for Finance, one department for
 * its head. The scoping is the permission — a head asking for the list gets their
 * own team rather than a refusal, and there is no parameter they could pass to
 * widen it.
 */
export async function listUsers(actor: Actor) {
  assertCan(actor, "user.manageOwnTeam", { festId: actor.festId, departmentId: actor.departmentId });
  const festWide = canFestWide(actor, "user.manage");
  return db
    .select({
      id: users.id, name: users.name, email: users.email, role: users.role,
      status: users.status, upiId: users.upiId, phone: users.phone,
      isSuperAdmin: users.isSuperAdmin,
      department: departments.name, departmentId: users.departmentId,
    })
    .from(users).innerJoin(departments, eq(departments.id, users.departmentId))
    .where(and(
      eq(users.festId, actor.festId),
      festWide ? undefined : eq(users.departmentId, actor.departmentId),
    ))
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
