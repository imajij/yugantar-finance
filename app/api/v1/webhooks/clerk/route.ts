/**
 * PRD 20.3 — `user.created` / `user.updated` link a Clerk account to the INVITED
 * row with that email. Unknown emails are rejected: an invitation from the Finance
 * HOD is what grants access, never the fact that someone managed to sign up.
 *
 * The route is public by design; the Svix signature is the authentication. It is
 * excluded from the session check in `proxy.ts` for the same reason.
 */
import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { recordAudit, snapshot } from "@/lib/services/audit";
import {
  emailDomainAllowed, fullName, primaryEmail, type ClerkUserEvent,
} from "@/lib/clerk";

const AUDITED = ["email", "name", "role", "status", "clerkUserId"] as const;

/** Svix reads `CLERK_WEBHOOK_SIGNING_SECRET`; PRD 18.3 calls it `CLERK_WEBHOOK_SECRET`. */
function signingSecret(): string | undefined {
  return process.env.CLERK_WEBHOOK_SIGNING_SECRET ?? process.env.CLERK_WEBHOOK_SECRET;
}

export async function POST(request: NextRequest) {
  const secret = signingSecret();
  if (!secret) {
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Webhook secret not configured" } },
      { status: 403 },
    );
  }

  let event: { type: string; data: unknown };
  try {
    const { verifyWebhook } = await import("@clerk/nextjs/webhooks");
    event = (await verifyWebhook(request, { signingSecret: secret })) as typeof event;
  } catch (error) {
    console.error("[clerk-webhook] signature verification failed", error);
    return Response.json(
      { error: { code: "FORBIDDEN", message: "Invalid signature" } },
      { status: 403 },
    );
  }

  if (event.type !== "user.created" && event.type !== "user.updated") {
    return Response.json({ ignored: event.type });
  }

  const data = event.data as ClerkUserEvent;
  const email = primaryEmail(data);
  if (!email) return Response.json({ ignored: "no email address" });

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  if (!existing) {
    // Nobody invited this address. Say so plainly in the log — this is the line
    // that keeps a stranger with a college email out of the fest's finances.
    console.warn(`[clerk-webhook] refused ${email}: no invitation on any fest`);
    return Response.json({ linked: false, reason: "not invited" }, { status: 202 });
  }

  if (!emailDomainAllowed(email) && existing.role !== "MANAGEMENT") {
    console.warn(`[clerk-webhook] refused ${email}: outside the allowed domain`);
    return Response.json({ linked: false, reason: "domain not allowed" }, { status: 202 });
  }

  // A Clerk account already bound to a different row means two identities are
  // fighting over one seat. Refuse rather than silently re-point the link.
  const [clash] = await db.select({ id: users.id }).from(users)
    .where(and(eq(users.clerkUserId, data.id))).limit(1);
  if (clash && clash.id !== existing.id) {
    console.warn(`[clerk-webhook] refused ${email}: clerk id already linked to another user`);
    return Response.json({ linked: false, reason: "already linked" }, { status: 202 });
  }

  const updated = await db.transaction(async (tx) => {
    const [after] = await tx.update(users).set({
      clerkUserId: data.id,
      name: fullName(data) ?? existing.name,
      // An invitation becomes an account the first time they sign in. A DISABLED
      // user staying disabled is the point — re-signing-in must not reinstate them.
      status: existing.status === "INVITED" ? "ACTIVE" : existing.status,
      updatedAt: new Date(),
    }).where(eq(users.id, existing.id)).returning();

    await recordAudit(tx, {
      festId: existing.festId,
      entityType: "USER",
      entityId: existing.id,
      actorId: null,
      action: `clerk.${event.type}`,
      before: snapshot(existing, AUDITED),
      after: snapshot(after, AUDITED),
    });
    return after;
  });

  return Response.json({ linked: true, user_id: updated.id, status: updated.status });
}
