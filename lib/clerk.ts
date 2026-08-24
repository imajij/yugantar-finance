/**
 * Clerk is identity only (PRD 18.1). Role, department and fest live in our `users`
 * table; nothing in this file decides what anyone may do.
 *
 * Two directions:
 *   - **In.** The `user.created` / `user.updated` webhook links a Clerk account to
 *     the INVITED row with the same email. An email outside the college domain, or
 *     one nobody invited, is refused — that is the access control on sign-up.
 *   - **Out.** Inviting someone from the admin screen creates the row here first and
 *     asks Clerk to email them an invitation.
 *
 * Every call degrades quietly when Clerk is not configured, so the emailed sign-in
 * link path keeps working and the admin screen still creates users.
 */
import { env, envOr } from "@/lib/env";

/**
 * Clerk needs **both** keys, and asking for only one is a trap worth naming.
 *
 * The secret authenticates our server calls; the publishable key is what mounts
 * `ClerkProvider` and what `clerkMiddleware` needs in order to run at all. With only
 * the secret, `clerkConfigured()` would say yes, `getSession()` would call `auth()`,
 * and `auth()` would throw because the middleware never ran — a 500 on every page,
 * including the sign-in screen, with no way back in.
 *
 * So: both, or neither. Half-configured degrades to emailed sign-in links and says
 * so in the log, because that is recoverable and a blank 500 is not.
 *
 * `proxy.ts` keeps its own copy of this rule — proxy code cannot import shared
 * modules — and the two must agree. `tests/unit/clerk-config.test.ts` checks that.
 */
export const CLERK_KEYS = ["CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"] as const;

/**
 * Read at request time and handed to `ClerkProvider` as a prop, so the app does not
 * depend on `NEXT_PUBLIC_` build-time inlining having happened. See `app/layout.tsx`.
 */
export const clerkPublishableKey = () => env("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");

let warnedAboutHalfConfig = false;

export function clerkConfigured(): boolean {
  const set = CLERK_KEYS.filter((k) => env(k) !== undefined);
  if (set.length === CLERK_KEYS.length) return true;

  if (set.length > 0 && !warnedAboutHalfConfig) {
    warnedAboutHalfConfig = true;
    const missing = CLERK_KEYS.filter((k) => env(k) === undefined);
    console.warn(
      `[clerk] ${set.join(" and ")} is set but ${missing.join(" and ")} is not, so Clerk is `
      + "disabled and sign-in falls back to emailed links. Set both keys, or neither.",
    );
  }
  return false;
}

export const allowedEmailDomain = () => env("ALLOWED_EMAIL_DOMAIN")?.toLowerCase() ?? null;

/**
 * PRD 13 — sign-in is restricted to the college Google Workspace domain, with
 * invited external Management users as the documented exception. An invitation
 * having been issued is what makes an outside address acceptable, so the domain
 * check is advisory and the "were they invited" check is the real gate.
 */
export function emailDomainAllowed(email: string): boolean {
  const domain = allowedEmailDomain();
  if (!domain) return true;
  return email.toLowerCase().endsWith(`@${domain}`);
}

const API = "https://api.clerk.com/v1";

async function clerkFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const key = env("CLERK_SECRET_KEY");
  if (!key) throw new Error("CLERK_SECRET_KEY is not set");
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Sends a Clerk invitation. Returns false rather than throwing: the user row is
 * already committed, and a mail-provider hiccup should not undo an invitation the
 * Finance HOD can simply re-send.
 */
export async function sendClerkInvitation(email: string, redirectPath = "/dashboard"): Promise<boolean> {
  if (!clerkConfigured()) {
    console.info(`[clerk:dry-run] would invite ${email}`);
    return false;
  }
  try {
    const appUrl = envOr("APP_URL", "http://localhost:3000").replace(/\/$/, "");
    const res = await clerkFetch("/invitations", {
      method: "POST",
      body: JSON.stringify({
        email_address: email,
        redirect_url: `${appUrl}${redirectPath}`,
        ignore_existing: true,
      }),
    });
    if (!res.ok) {
      console.error(`[clerk] invitation failed ${res.status}: ${await res.text()}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[clerk] invitation failed", error);
    return false;
  }
}

/** Revokes access when a user is disabled. Clerk keeps the account; we drop the link. */
export async function revokeClerkSessions(clerkUserId: string): Promise<void> {
  if (!clerkConfigured()) return;
  try {
    const res = await clerkFetch(`/users/${clerkUserId}/sessions`, { method: "GET" });
    if (!res.ok) return;
    const sessions = (await res.json()) as { id: string }[];
    await Promise.all(
      sessions.map((s) => clerkFetch(`/sessions/${s.id}/revoke`, { method: "POST" })),
    );
  } catch (error) {
    console.error("[clerk] session revocation failed", error);
  }
}

/** The subset of the webhook payload we act on. */
export interface ClerkUserEvent {
  id: string;
  email_addresses: { id: string; email_address: string }[];
  primary_email_address_id: string | null;
  first_name: string | null;
  last_name: string | null;
}

export function primaryEmail(data: ClerkUserEvent): string | null {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
  return (primary ?? data.email_addresses[0])?.email_address?.toLowerCase() ?? null;
}

export function fullName(data: ClerkUserEvent): string | null {
  const name = [data.first_name, data.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

/**
 * Binds a Clerk account to the invited `users` row with the same verified email.
 *
 * The webhook (20.3) normally does this the moment an account is created. It is not
 * always configured — `CLERK_WEBHOOK_SECRET` is easy to leave blank, and a webhook
 * that was down for a minute leaves a permanent gap — and until the link exists
 * `loadByClerkId` finds nobody. The result is the worst kind of failure: Clerk says
 * you are signed in, the app says you are not, and you bounce between the two for
 * ever with no error anywhere.
 *
 * So the link is also established lazily, on the first request that needs it. The
 * rules are the webhook's rules, unchanged:
 *
 *   - the email must be **verified by Clerk**. An unverified address would let
 *     anyone claim an invited seat by typing that address at sign-up;
 *   - a `users` row must already exist for it — invitation is still the gate;
 *   - a DISABLED account stays disabled;
 *   - a Clerk id already bound elsewhere is refused rather than re-pointed.
 *
 * Costs one Clerk API call, and only on the request that does the binding.
 */
export interface ClerkIdentity {
  clerkUserId: string;
  email: string;
  name: string | null;
}

export async function currentClerkIdentity(): Promise<ClerkIdentity | null> {
  if (!clerkConfigured()) return null;

  try {
    const { currentUser } = await import("@clerk/nextjs/server");
    const user = await currentUser();
    if (!user) return null;

    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)
      ?? user.emailAddresses[0];
    if (!primary) return null;

    // Clerk marks a confirmed address `verified`. Anything else is a claim, not proof.
    if (primary.verification?.status !== "verified") {
      console.warn(`[clerk] ${primary.emailAddress} is not verified — not linking it to an account`);
      return null;
    }

    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    return {
      clerkUserId: user.id,
      email: primary.emailAddress.toLowerCase(),
      name: name || null,
    };
  } catch (error) {
    console.error("[clerk] could not read the current user", error);
    return null;
  }
}
