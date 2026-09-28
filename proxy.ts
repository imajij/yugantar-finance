/**
 * Next 16 renamed `middleware` to `proxy`; the runtime is Node, not Edge.
 *
 * One job: security headers on every response (PRD 14). A strict CSP matters here
 * because receipts and invoices are rendered in the same origin as the app. The
 * session itself is checked where it is used (`lib/session.ts`), not here.
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
  const storage = r2Origin();

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https: 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    `font-src 'self' https://fonts.gstatic.com data:`,
    `img-src 'self' blob: data: https:`,
    `connect-src 'self'${storage}`,
    `frame-src 'self'`,
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

  return applyHeaders(NextResponse.next({ request: { headers } }), nonce);
}

export const config = {
  // Skip Next's own static output and the public folder.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
