/**
 * Resolves the caller to an `Actor` (PRD 13, 18.2 rule 10).
 *
 * Identity is a sign-in link: a one-time link emailed to an already-invited
 * address, backed by a server-side session (`lib/auth.ts`). It lands on a row in
 * `users`, with a role and a department; nothing downstream of this file knows how
 * the caller got in.
 */
import { cookies } from "next/headers";
import type { Actor } from "@/lib/authz";
import { SESSION_COOKIE, resolveSession } from "@/lib/auth";

export { SESSION_COOKIE };

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

/** Null when nobody is signed in. Handlers use `requireSession` instead. */
export async function getSession(): Promise<SessionUser | null> {
  return resolveSession((await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireSession(): Promise<SessionUser> {
  const user = await getSession();
  if (!user) throw new Unauthenticated();
  if (user.status === "DISABLED") throw new Unauthenticated("This account has been disabled");
  return user;
}
