import { toErrorResponse } from "@/lib/api";
import { publicBillUrl } from "@/lib/services/attachments";

/**
 * The bill links written into the reimbursement export. Deliberately reachable with
 * no session, so a spreadsheet can be handed to someone without an account: the
 * signature in the link is the authority, standing in for `can()`.
 *
 * Redirects rather than serving the bytes, so the file still comes from storage on
 * a fifteen-minute URL minted now. No-store: that URL must not be cached and handed
 * on. A bare `Location` because local storage signs a relative URL.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const signature = new URL(request.url).searchParams.get("sig") ?? "";
    return new Response(null, {
      status: 302,
      headers: {
        location: await publicBillUrl(id, signature),
        "cache-control": "no-store",
        "x-robots-tag": "noindex",
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
