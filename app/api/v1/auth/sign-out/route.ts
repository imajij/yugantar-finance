import { cookies } from "next/headers";
import { SESSION_COOKIE, revokeSession } from "@/lib/auth";

/**
 * Signing out revokes the session row as well as clearing the cookie. Clearing the
 * cookie alone would leave a live credential in anyone's hands who had copied it.
 */
export async function POST() {
  const jar = await cookies();
  await revokeSession(jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
