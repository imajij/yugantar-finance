/**
 * Resolves the caller to an `Actor` (PRD 13, 18.2 rule 10).
 *
 * Clerk is identity only — role and department live in our `users` table. When Clerk
 * is not configured we fall back to a dev sign-in that picks a seeded user by email,
 * so the app is demoable before auth is wired. The fallback refuses to run in
 * production, and refuses to run at all once CLERK_SECRET_KEY is set.
 */
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import type { Actor } from "@/lib/authz";
import { clerkConfigured } from "@/lib/clerk";

export const DEV_USER_COOKIE = "yg_dev_user";

export { clerkConfigured };

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

const devAuthAllowed = () => !clerkConfigured() && process.env.NODE_ENV !== "production";

async function loadByEmail(email: string): Promise<SessionUser | null> {
  const [row] = await db
    .select({
      id: users.id, festId: users.festId, role: users.role, departmentId: users.departmentId,
      name: users.name, email: users.email, status: users.status, upiId: users.upiId,
      departmentName: departments.name, departmentKind: departments.kind,
    })
    .from(users)
    .innerJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.email, email))
    .limit(1);
  return row ?? null;
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
    return loadByClerkId(userId);
  }

  if (!devAuthAllowed()) return null;

  const email = (await cookies()).get(DEV_USER_COOKIE)?.value;
  if (!email) return null;
  const user = await loadByEmail(email);
  return user?.status === "DISABLED" ? null : user;
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new Unauthenticated();
  if (user.status === "DISABLED") throw new Unauthenticated("This account has been disabled");
  return user;
}

/** The dev sign-in screen lists these. Empty once Clerk is configured. */
export async function devSignInCandidates(): Promise<{ email: string; name: string; role: string; department: string }[]> {
  if (!devAuthAllowed()) return [];
  return db
    .select({ email: users.email, name: users.name, role: users.role, department: departments.name })
    .from(users)
    .innerJoin(departments, eq(departments.id, users.departmentId))
    .where(eq(users.status, "ACTIVE"))
    .orderBy(users.role, users.name);
}
