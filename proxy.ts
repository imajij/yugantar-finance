/**
 * Next 16 renamed `middleware` to `proxy`; the runtime is Node, not Edge.
 *
 * Two jobs, in this order:
 *   1. Security headers on every response (PRD 14). A strict CSP matters here because
 *      receipts and invoices are rendered in the same origin as the app.
 *   2. Clerk's session resolution, which has to run for `auth()` to work in server
 *      components. It is loaded lazily so a deployment without Clerk — a preview
 *      branch, a local dev database — never pulls it in and never fails on a missing key.
 */
import { NextResponse, type NextRequest } from "next/server";

/**
 * Blank is unset — `.env.example` ships the optional variables with nothing after
 * the `=`, so an empty string is the normal way for one to be "not configured".
 * Inlined rather than imported from `lib/env.ts`: proxy code is meant to stand alone
 * (Next can deploy it to the CDN edge), so it keeps its own copy of this one line.
 */
const env = (name: string): string | undefined => {
  const raw = process.env[name]?.trim();
  return raw === "" ? undefined : raw;
};

/**
 * Both keys, or Clerk is off — the same rule as `clerkConfigured()` in `lib/clerk.ts`,
 * which explains why. The two are separate copies because proxy code cannot import
 * shared modules, and `tests/unit/clerk-config.test.ts` checks they have not drifted:
 * if this said yes where the app said no, `clerkMiddleware` would not run and every
 * `auth()` call would throw.
 */
const CLERK_KEYS = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"];
const clerkConfigured = () => CLERK_KEYS.every((k) => env(k) !== undefined);

/**
 * The bucket's own origin, when R2 is configured.
 *
 * Receipts are PUT straight from the browser to a presigned URL (PRD 20.2), which is
 * a cross-origin `fetch` — so `connect-src` has to name the bucket or the CSP blocks
 * every upload. Only uploads: downloads are rendered server-side into `<a>` and
 * `<img>`, which `img-src` already covers.
 *
 * Mirrors `r2Config()` in `lib/storage.ts` rather than importing it: proxy code is
 * meant to stand alone (it can be deployed to the CDN edge), and this needs one
 * string, not a module.
 */
function r2Origin(): string {
  const accountId = env("R2_ACCOUNT_ID");
  if (!accountId || !env("R2_ACCESS_KEY_ID") || !env("R2_SECRET_ACCESS_KEY") || !env("R2_BUCKET")) {
    return "";
  }
  try {
    return ` ${new URL(env("R2_ENDPOINT") ?? `https://${accountId}.r2.cloudflarestorage.com`).origin}`;
  } catch {
    return "";
  }
}

/**
 * `unsafe-inline` on styles is needed by Next's own style injection; scripts get a
 * nonce instead. `frame-ancestors 'none'` is the header form of X-Frame-Options and
 * is what actually stops this app being framed by a phishing page.
 */
function securityHeaders(nonce: string): Record<string, string> {
  const clerk = clerkConfigured()
    ? " https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com"
    : "";
  const storage = r2Origin();

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' blob: data: https:`,
    `connect-src 'self'${clerk}${storage}`,
    `frame-src 'self'${clerk}`,
    `worker-src 'self' blob:`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  return {
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    // Receipts are uploaded from phone cameras; nothing else needs a device.
    "permissions-policy": "camera=(self), microphone=(), geolocation=(), payment=()",
    "x-frame-options": "DENY",
    ...(process.env.NODE_ENV === "production"
      ? { "strict-transport-security": "max-age=63072000; includeSubDomains; preload" }
      : {}),
  };
}

function applyHeaders(response: Response, nonce: string): Response {
  for (const [k, v] of Object.entries(securityHeaders(nonce))) response.headers.set(k, v);
  return response;
}

export async function proxy(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");

  // Pass the nonce down so Next can stamp it onto the scripts it injects.
  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  const forward = { request: { headers } };

  if (!clerkConfigured()) {
    return applyHeaders(NextResponse.next(forward), nonce);
  }

  const { clerkMiddleware, createRouteMatcher } = await import("@clerk/nextjs/server");

  // Everything is behind the session except the sign-in screen, the Clerk webhook
  // (signature-authenticated) and cron (CRON_SECRET-authenticated).
  const isPublic = createRouteMatcher([
    "/sign-in(.*)",
    // Sign-in links: no session yet, by definition.
    "/auth/callback",
    "/api/v1/auth(.*)",
    "/api/v1/webhooks(.*)",
    "/api/v1/cron(.*)",
    // Presigned upload and download URLs carry their own signature.
    "/api/v1/attachments/upload",
    "/api/v1/attachments/download",
  ]);

  const handler = clerkMiddleware(
    async (auth, req) => {
      if (!isPublic(req)) await auth.protect();
      return NextResponse.next(forward);
    },
    {
      // Passed explicitly rather than left to `NEXT_PUBLIC_` inlining, which happens
      // at build time. A deployment that gained the variable after its last build
      // would otherwise throw "Missing publishableKey" here — in the proxy, so on
      // every route including the cron endpoints and the sign-in page, with nothing
      // in the response to say why. Reading it at request time makes a redeploy
      // unnecessary and the failure impossible.
      // Only the publishable key. `CLERK_SECRET_KEY` has no `NEXT_PUBLIC_` prefix,
      // so it is read at runtime already — and passing it here would additionally
      // demand a `CLERK_ENCRYPTION_KEY` to propagate it with.
      publishableKey: env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"),
    },
  );

  const result = await handler(request, {} as never);
  return result ? applyHeaders(result, nonce) : applyHeaders(NextResponse.next(forward), nonce);
}

export const config = {
  // Skip Next's own static output and the public folder; auth logic must never
  // sit between the browser and a stylesheet.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
