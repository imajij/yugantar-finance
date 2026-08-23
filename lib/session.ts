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
import { clerkConfigured } from "@/lib/clerk";
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
    return loadByClerkId(userId);
  }

  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new Unauthenticated();
  if (user.status === "DISABLED") throw new Unauthenticated("This account has been disabled");
  return user;
}
