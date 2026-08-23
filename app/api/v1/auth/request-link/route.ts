import { z } from "zod";
import { errorResponse, toErrorResponse } from "@/lib/api";
import { requestSignInLink } from "@/lib/auth";
import { clerkConfigured } from "@/lib/clerk";
import { consume } from "@/lib/rate-limit";

const schema = z.object({ email: z.email().max(320) });

/**
 * Asks for a sign-in link (PRD 13, adapted — see `lib/auth.ts`).
 *
 * Public by necessity: there is no session yet. Three things stand in for one.
 *
 *   The **response never varies**. Unknown address, disabled account, invited
 *   account — all return the same body. Otherwise this endpoint answers "is this
 *   person on the finance committee?" to anyone who asks.
 *
 *   The **rate limit is on the address and the caller**, not just the caller, so
 *   somebody cannot flood one person's inbox from many IPs, nor many inboxes from
 *   one. Both are consumed even when the address is unknown, or the limiter itself
 *   would leak which addresses exist by only throttling the real ones.
 *
 *   **Issuing is invitation-gated** inside the service. Nobody signs themselves up.
 */
export async function POST(request: Request) {
  if (clerkConfigured()) {
    // Two live ways in is one too many. Clerk is the only door where it exists.
    return errorResponse("NOT_FOUND", "Sign in with your college account instead");
  }

  try {
    const body = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);

    const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
    const email = parsed.success ? parsed.data.email.trim().toLowerCase() : null;

    const [byIp, byEmail] = await Promise.all([
      consume("signInLinkPerIp", ip ?? "unknown"),
      consume("signInLink", email ?? "invalid"),
    ]);

    if (!byIp.allowed || !byEmail.allowed) {
      const resetAt = byIp.allowed ? byEmail.resetAt : byIp.resetAt;
      const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
      return errorResponse("RATE_LIMITED", `Too many sign-in requests. Try again in ${retryAfter}s.`, {
        retry_after_seconds: retryAfter,
      });
    }

    if (email) await requestSignInLink({ email, ip });

    // Deliberately identical for a malformed address, an unknown one, and a real one.
    return Response.json({
      ok: true,
      message: "If that address has been invited, a sign-in link is on its way.",
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
