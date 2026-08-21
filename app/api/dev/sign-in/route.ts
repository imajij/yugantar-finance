import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { DEV_USER_COOKIE, clerkConfigured, devSignInCandidates } from "@/lib/session";

/**
 * Dev-only sign-in. Disappears the moment Clerk is configured, and refuses to run
 * in production regardless — `devSignInCandidates` returns nothing in either case.
 */
export async function POST(request: Request) {
  if (clerkConfigured() || process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not available" } }, { status: 404 });
  }

  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const allowed = await devSignInCandidates();
  if (!allowed.some((u) => u.email === email)) {
    return NextResponse.json({ error: { code: "FORBIDDEN", message: "Unknown user" } }, { status: 403 });
  }

  const jar = await cookies();
  jar.set(DEV_USER_COOKIE, email, { httpOnly: true, sameSite: "lax", path: "/" });
  return NextResponse.redirect(new URL("/dashboard", request.url), 303);
}

export async function DELETE() {
  (await cookies()).delete(DEV_USER_COOKIE);
  return NextResponse.json({ ok: true });
}
