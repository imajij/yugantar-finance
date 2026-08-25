import { NextResponse } from "next/server";
import { route } from "@/lib/api";
import { attachmentUrl } from "@/lib/services/attachments";

/**
 * PRD 20.2 — a signed GET URL for one attachment.
 *
 * This endpoint is the access control on every receipt, invoice and MoU in the
 * system: the service checks that the caller can see the parent record before a URL
 * exists at all (PRD 11).
 *
 * Two shapes, one check.
 *
 *   - Plain, it returns `{ url, expires_in }` for a caller that wants the URL.
 *   - `?redirect=1` answers with a 302 to that URL, which is what a page should put
 *     in an `href`.
 *
 * The redirect exists because minting the signed URL when the *page* renders makes
 * the link go stale on the reader's screen: leave a request open for twenty minutes,
 * click the receipt, and it 403s — the file is fine, the signature is not, and
 * nothing about that is the reader's problem to understand. Pointing the anchor
 * here instead means the signature is minted when the link is *clicked*, so it is
 * always fresh and the permission check runs at that moment rather than at render.
 */
export const GET = route<{ id: string }>(async ({ user, params, request }) => {
  const { url, expires_in } = await attachmentUrl(user, params.id);

  if (new URL(request.url).searchParams.get("redirect") === "1") {
    // No-store: the 302 carries a short-lived signature and must never be cached
    // by a shared proxy and handed to somebody else.
    return NextResponse.redirect(url, { status: 302, headers: { "cache-control": "no-store" } });
  }
  return { url, expires_in };
});
