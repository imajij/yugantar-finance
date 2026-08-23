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

const clerkConfigured = () =>
  Boolean(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);

/**
 * `unsafe-inline` on styles is needed by Next's own style injection; scripts get a
 * nonce instead. `frame-ancestors 'none'` is the header form of X-Frame-Options and
 * is what actually stops this app being framed by a phishing page.
 */
function securityHeaders(nonce: string): Record<string, string> {
  const clerk = clerkConfigured()
    ? " https://*.clerk.accounts.dev https://*.clerk.com https://challenges.cloudflare.com"
    : "";

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' blob: data: https:`,
    `connect-src 'self'${clerk}`,
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
    "/api/v1/webhooks(.*)",
    "/api/v1/cron(.*)",
    // Presigned upload and download URLs carry their own signature.
    "/api/v1/attachments/upload",
    "/api/v1/attachments/download",
  ]);

  const handler = clerkMiddleware(async (auth, req) => {
    if (!isPublic(req)) await auth.protect();
    return NextResponse.next(forward);
  });

  const result = await handler(request, {} as never);
  return result ? applyHeaders(result, nonce) : applyHeaders(NextResponse.next(forward), nonce);
}

export const config = {
  // Skip Next's own static output and the public folder; auth logic must never
  // sit between the browser and a stylesheet.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
