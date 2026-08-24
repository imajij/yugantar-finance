/**
 * Resolves the caller to an `Actor` (PRD 13, 18.2 rule 10).
 *
 * Two identity providers, checked in that order:
 *
 *   1. **Clerk**, when it is configured. Google sign-in restricted to the college
 *      domain, exactly as PRD 18.1 specifies. Clerk is identity only — role and
 *      department live in our `users` table and authorization is decided in our code.
 *   2. **Sign-in links**, otherwise. A one-time link emailed to an already-invited
 *      address, backed by a server-side session (`lib/auth.ts`).
 *
 * Both land in the same place: a row in `users`, with a role and a department. Nothing
 * downstream of this file knows or cares which one the caller came through.
 */
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import {
  allowedEmailDomain, clerkConfigured, currentClerkIdentity, emailDomainAllowed,
} from "@/lib/clerk";
import { SESSION_COOKIE, resolveSession } from "@/lib/auth";

export { clerkConfigured, SESSION_COOKIE };

export class Unauthenticated extends Error {
  readonly code = "UNAUTHENTICATED";
  constructor(message = "Sign in to continue") {
    super(message);
    this.name = "Unauthenticated";
  }
}

export interface SessionUser extends Actor {
  name: string;
  email: string;
  departmentName: string;
  departmentKind: "BUDGET" | "FINANCE" | "CORE";
  upiId: string | null;
  status: "INVITED" | "ACTIVE" | "DISABLED";
}

async function loadByClerkId(clerkUserId: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      id: users.id, festId: users.festId, role: users.role, departmentId: users.departmentId,
      name: users.name, email: users.email, status: users.status, upiId: users.upiId,
      departmentName: departments.name, departmentKind: departments.kind,
    })
    .from(users)
    .innerJoin(departments, eq(departments.id, users.departmentId))
    .where(and(eq(users.clerkUserId, clerkUserId), eq(users.status, "ACTIVE")))
    .limit(1);
  return row ?? null;
}

/** Null when nobody is signed in. Handlers use `requireSession` instead. */
export async function getSession(): Promise<SessionUser | null> {
  if (clerkConfigured()) {
    // ponytail: resolved lazily so the app runs with Clerk uninstalled.
    const { auth } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    if (!userId) return null;

    const linked = await loadByClerkId(userId);
    if (linked) return linked;

    // No link yet. The webhook may be unconfigured or may have missed this account,
    // and without a link Clerk says signed-in while the app says not — a loop with
    // no error. Bind it here instead, on the same terms (see `linkClerkAccount`).
    return linkClerkAccount(userId);
  }

  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}

/**
 * Establishes the Clerk ↔ `users` link on first sign-in when the webhook has not.
 * Returns null — and logs why — for anyone who was never invited, which is the
 * access-control decision this file must not get wrong.
 */
async function linkClerkAccount(clerkUserId: string): Promise<SessionUser | null> {
  const identity = await currentClerkIdentity();
  if (!identity || identity.clerkUserId !== clerkUserId) return null;

  const [invited] = await db
    .select({ id: users.id, status: users.status, role: users.role, clerkUserId: users.clerkUserId })
    .from(users)
    .where(eq(users.email, identity.email))
    .limit(1);

  if (!invited) {
    console.warn(`[clerk] ${identity.email} signed in but was never invited — refusing`);
    return null;
  }
  if (invited.status === "DISABLED") {
    console.warn(`[clerk] ${identity.email} signed in but the account is disabled — refusing`);
    return null;
  }
  // The same domain rule the webhook applies (20.3). `inviteUser` already enforces it
  // when the row is created, so this only catches a row that predates the setting —
  // but the two paths into an account must not disagree about who may use it.
  if (!emailDomainAllowed(identity.email) && invited.role !== "MANAGEMENT") {
    console.warn(`[clerk] ${identity.email} is outside ${allowedEmailDomain()} — refusing`);
    return null;
  }
  if (invited.clerkUserId && invited.clerkUserId !== clerkUserId) {
    console.warn(`[clerk] ${identity.email} is already linked to a different Clerk account — refusing`);
    return null;
  }

  await db.update(users).set({
    clerkUserId,
    name: identity.name ?? undefined,
    // Accepting the invitation is what makes someone active, exactly as the webhook
    // and the sign-in-link path both do.
    status: invited.status === "INVITED" ? "ACTIVE" : invited.status,
    updatedAt: new Date(),
  }).where(eq(users.id, invited.id));

  console.info(`[clerk] linked ${identity.email} on first sign-in (webhook had not)`);
  return loadByClerkId(clerkUserId);
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new Unauthenticated();
  if (user.status === "DISABLED") throw new Unauthenticated("This account has been disabled");
  return user;
}
