import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, consumeSignInToken, createSession, sessionCookieOptions } from "@/lib/auth";

/**
 * Where a sign-in link lands. Spends the token, opens a session, redirects in.
 *
 * A GET that changes state is unusual, and it is what a link in an email has to be.
 * What makes it safe is that the token is single-use and short-lived, so a prefetch
 * or a scanner following the link burns it rather than granting anything — the
 * person then asks for another. The alternative, an interstitial "click to confirm"
 * page, trades that for a worse failure: a link that survives being logged.
 *
 * The token never survives into the address bar: the redirect drops it, so it does
 * not end up in browser history or in a `Referer` header on the next request.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const consumed = token ? await consumeSignInToken(token) : null;

  if (!consumed) {
    return NextResponse.redirect(new URL("/sign-in?error=link", request.url));
  }

  const { token: sessionToken, expiresAt } = await createSession(consumed.userId, {
    userAgent: request.headers.get("user-agent"),
    ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  (await cookies()).set(SESSION_COOKIE, sessionToken, sessionCookieOptions(expiresAt));
  return NextResponse.redirect(new URL("/dashboard", request.url));
}
