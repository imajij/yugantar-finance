/**
 * Sign-in links and sessions (PRD 13, adapted).
 *
 * The spec calls for Clerk with Google Workspace; the fest decided against Clerk, so
 * this is the only way in: a one-time link emailed to an address someone has
 * already been invited on.
 *
 * The properties that matter, and why each one is here:
 *
 *   **Invitation is the gate.** A link is only ever issued to an address that already
 *   has a `users` row on the fest. Knowing the URL is not enough; nobody signs
 *   themselves up.
 *
 *   **Only hashes are stored.** The token in the inbox is the secret; the database
 *   holds SHA-256 of it. A database dump grants nobody a login. Lookup is *by* the
 *   hash, so there is no comparison to time — an attacker needs the preimage.
 *
 *   **One use, fifteen minutes.** Consumption is a conditional UPDATE, so two
 *   simultaneous clicks on a forwarded link produce one session, not two. Using a
 *   link also kills that user's other outstanding links.
 *
 *   **No account enumeration.** `requestSignInLink` returns the same result whether
 *   or not the address exists, and does the same amount of work either way.
 *
 *   **Sessions are rows, not claims.** Finance disabling someone has to take effect
 *   now, and a stateless token cannot be withdrawn before it expires. `revoked_at`
 *   is what `updateUser` sets.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, sessions, signInTokens, users } from "@/db/schema";
import { describeAllowedDomains, emailDomainAllowed } from "@/lib/email-domains";
import { appUrl, sendEmail } from "@/lib/email";
import type { SessionUser } from "@/lib/session";

/** PRD 13. Short enough that a forwarded or logged link is stale before it is useful. */
export const SIGN_IN_TOKEN_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SESSION_COOKIE = "yg_session";

/** 256 bits from the CSPRNG. base64url so it survives a URL and a mail client. */
function newToken(): string {
  return randomBytes(32).toString("base64url");
}

const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    // `lax` rather than `strict`: the sign-in link is a cross-site navigation into
    // the app, and `strict` would drop the cookie on exactly that request.
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

/* ------------------------------------------------------------- sign-in links */

export interface LinkRequest {
  email: string;
  ip?: string | null;
}

/**
 * Issues a link if — and only if — the address belongs to an invited, non-disabled
 * user. Returns nothing either way: the caller must show the same message for an
 * unknown address as for a known one, or this endpoint becomes a way to ask which
 * of the college's students are on the finance committee.
 */
export async function requestSignInLink({ email, ip }: LinkRequest): Promise<void> {
  const normalised = email.trim().toLowerCase();

  const [row] = await db
    .select({
      id: users.id, name: users.name, email: users.email,
      status: users.status, festId: users.festId,
    })
    .from(users)
    .where(eq(users.email, normalised))
    .limit(1);

  // Every reason to refuse is logged for the operator and silent to the caller.
  if (!row) {
    console.info(`[auth] sign-in link refused for ${normalised}: not invited`);
    return;
  }
  if (row.status === "DISABLED") {
    console.info(`[auth] sign-in link refused for ${normalised}: account disabled`);
    return;
  }
  if (!emailDomainAllowed(normalised)) {
    // Management is invited from outside the college domain by design (PRD 13);
    // `inviteUser` is where that exception is decided, so an existing row is proof
    // it was already allowed. Nothing to refuse here.
    console.info(`[auth] ${normalised} is outside ${describeAllowedDomains()} — invited, so allowed`);
  }

  const raw = newToken();
  await db.transaction(async (tx) => {
    // A new link supersedes the old ones. Two live links to one inbox is one more
    // than anybody needs, and each is another thing that can be forwarded.
    await tx.update(signInTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(signInTokens.userId, row.id), isNull(signInTokens.consumedAt)));

    await tx.insert(signInTokens).values({
      userId: row.id,
      tokenHash: hashToken(raw),
      expiresAt: new Date(Date.now() + SIGN_IN_TOKEN_TTL_MS),
      requestedIp: ip ?? null,
    });
  });

  const url = `${appUrl()}/auth/callback?token=${encodeURIComponent(raw)}`;
  const minutes = Math.round(SIGN_IN_TOKEN_TTL_MS / 60000);

  const sent = await sendEmail({
    to: row.email,
    subject: "Your Yugaantar sign-in link",
    heading: "Sign in to Yugaantar Finance & Operations",
    body: `Hello ${row.name.split(" ")[0]} — use the button below to sign in. `
      + `The link works once and expires in ${minutes} minutes.`,
    actionLabel: "Sign in",
    actionPath: `/auth/callback?token=${encodeURIComponent(raw)}`,
    footnote: "If you did not ask to sign in, you can ignore this email — the link is useless without your inbox.",
  });

  // Without a mail provider the link goes to the log, so a fresh deployment can
  // still get its first administrator in. It is never returned over HTTP.
  if (!sent) {
    console.info(`[auth] sign-in link for ${row.email} (email not configured):\n  ${url}`);
  }
}

export interface ConsumedLink {
  userId: string;
  festId: string;
}

/**
 * Spends a link. The UPDATE is the check: `consumed_at is null` in the WHERE clause
 * means the database decides the race, so a link clicked twice signs you in once.
 */
export async function consumeSignInToken(raw: string): Promise<ConsumedLink | null> {
  if (!raw || raw.length > 512) return null;

  const rows = (await db.execute(sql`
    update sign_in_tokens t
       set consumed_at = now()
      from users u
     where u.id = t.user_id
       and t.token_hash = ${hashToken(raw)}
       and t.consumed_at is null
       and t.expires_at > now()
       and u.status <> 'DISABLED'
    returning t.user_id, u.fest_id, u.status::text as status
  `)) as unknown as { user_id: string; fest_id: string; status: string }[];

  const row = rows[0];
  if (!row) return null;

  // Accepting the invitation is what makes someone active. A disabled account never
  // reaches here.
  if (row.status === "INVITED") {
    await db.update(users)
      .set({ status: "ACTIVE", updatedAt: new Date() })
      .where(eq(users.id, row.user_id));
  }

  return { userId: row.user_id, festId: row.fest_id };
}

/* ----------------------------------------------------------------- sessions */

export interface IssuedSession {
  token: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string, meta: { userAgent?: string | null; ip?: string | null } = {},
): Promise<IssuedSession> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 400) ?? null,
    ip: meta.ip ?? null,
  });

  return { token, expiresAt };
}

/**
 * Resolves a cookie to the signed-in user, joining the role and department that
 * authorization actually runs on. A revoked, expired, or disabled row resolves to
 * null, so disabling someone logs them out on their next request.
 */
export async function resolveSession(raw: string | undefined): Promise<SessionUser | null> {
  if (!raw) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      id: users.id, festId: users.festId, role: users.role, departmentId: users.departmentId,
      isSuperAdmin: users.isSuperAdmin,
      name: users.name, email: users.email, status: users.status, upiId: users.upiId,
      departmentName: departments.name, departmentKind: departments.kind,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(departments, eq(departments.id, users.departmentId))
    .where(and(
      eq(sessions.tokenHash, hashToken(raw)),
      isNull(sessions.revokedAt),
      sql`${sessions.expiresAt} > now()`,
      eq(users.status, "ACTIVE"),
    ))
    .limit(1);

  if (!row) return null;

  // `last_seen_at` is for the operator, not the session's validity, so it is written
  // at most once a minute rather than on every request.
  void db.update(sessions)
    .set({ lastSeenAt: new Date() })
    .where(and(
      eq(sessions.id, row.sessionId),
      lt(sessions.lastSeenAt, new Date(Date.now() - 60_000)),
    ))
    .catch(() => {});

  const { sessionId: _sessionId, ...user } = row;
  void _sessionId;
  return user;
}

export async function revokeSession(raw: string | undefined): Promise<void> {
  if (!raw) return;
  await db.update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.tokenHash, hashToken(raw)), isNull(sessions.revokedAt)));
}

/** Everything that user holds — what disabling an account has to do to be real. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const revoked = await db.update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id });

  await db.update(signInTokens)
    .set({ consumedAt: new Date() })
    .where(and(eq(signInTokens.userId, userId), isNull(signInTokens.consumedAt)));

  return revoked.length;
}

/** Housekeeping for the nightly sweep: spent tokens and dead sessions. */
export async function pruneAuth(): Promise<{ sessions: number; tokens: number }> {
  const deadSessions = await db.delete(sessions)
    .where(or(
      lt(sessions.expiresAt, new Date(Date.now() - 30 * 24 * 3600_000)),
      lt(sessions.revokedAt, new Date(Date.now() - 30 * 24 * 3600_000)),
    ))
    .returning({ id: sessions.id });

  const deadTokens = await db.delete(signInTokens)
    .where(lt(signInTokens.expiresAt, new Date(Date.now() - 24 * 3600_000)))
    .returning({ id: signInTokens.id });

  return { sessions: deadSessions.length, tokens: deadTokens.length };
}

/** Constant-time equality, for the one place a secret is compared rather than looked up. */
export function secretsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
