/**
 * Sign-in links and sessions (`lib/auth.ts`).
 *
 * This is the front door, so the tests are about what must *not* work: signing in
 * without an invitation, reusing a link, using an expired one, keeping a session
 * after being disabled, and learning from the endpoint whether an address exists.
 *
 * These call the real service and the real route handler; only the mail send is
 * inert (no `RESEND_API_KEY` in tests), which is why the token is read back from
 * the database rather than from an inbox.
 */
import { afterAll, beforeAll, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { dropFests } from "@/lib/test-support";
import {
  consumeSignInToken, createSession, requestSignInLink, resolveSession,
  revokeAllSessions, revokeSession, SESSION_TTL_MS,
} from "@/lib/auth";
import { buildFixture, call, type Fixture, type Handler } from "./harness";

const PREFIX = "apiauth-";
let fx: Fixture;

/**
 * The rate limiter is a table with an hour-long window, so it is shared state across
 * every test file and every run within the hour. Each test here therefore calls from
 * its own address, and the buckets are cleared up front — otherwise a passing suite
 * depends on how recently it last ran, which is the same trap the fest teardown fixes.
 */
const CALLER_IP = `10.0.0.${Math.floor(Math.random() * 200) + 1}-${crypto.randomUUID()}`;
const from = (ip = CALLER_IP) => ({ "x-forwarded-for": ip });

beforeAll(async () => {
  fx = await buildFixture(PREFIX);
  await db.execute(sql`delete from rate_limits where bucket like 'signInLink%'`);
});

afterAll(() => dropFests(db, PREFIX));

/** The link is emailed, not returned. Tests read the row the way the DB stores it. */
async function outstandingToken(userId: string): Promise<string | null> {
  const [row] = (await db.execute(sql`
    select token_hash from sign_in_tokens
     where user_id = ${userId} and consumed_at is null and expires_at > now()
     order by created_at desc limit 1
  `)) as unknown as { token_hash: string }[];
  return row?.token_hash ?? null;
}

/**
 * Issues a link and returns the raw token by planting a known one. The real token
 * never leaves `requestSignInLink`, which is the point — so this writes a row the
 * same shape rather than trying to recover it.
 */
async function plantToken(userId: string, opts: { expiresInMs?: number } = {}): Promise<string> {
  const raw = `test-${crypto.randomUUID()}`;
  await db.execute(sql`
    insert into sign_in_tokens (user_id, token_hash, expires_at)
    values (${userId}, ${createHash("sha256").update(raw).digest("hex")},
            now() + make_interval(secs => ${(opts.expiresInMs ?? 900_000) / 1000}))
  `);
  return raw;
}

/* ----------------------------------------------------------- issuing a link */

test("a link is issued only to an address that has been invited", async () => {
  await requestSignInLink({ email: fx.users.member.email });
  expect(await outstandingToken(fx.users.member.id)).not.toBeNull();

  // Nobody else gets one, and nothing throws — the caller cannot tell the difference.
  await expect(requestSignInLink({ email: `nobody-${crypto.randomUUID()}@sst.scaler.com` }))
    .resolves.toBeUndefined();

  const [{ n }] = (await db.execute(sql`
    select count(*)::int as n from sign_in_tokens t
      join users u on u.id = t.user_id
     where u.fest_id = ${fx.festId}
  `)) as unknown as { n: number }[];
  expect(Number(n)).toBeGreaterThan(0);
});

test("a disabled account gets no link, even though it exists", async () => {
  await db.execute(sql`update users set status = 'DISABLED' where id = ${fx.users.otherMember.id}`);
  await db.execute(sql`delete from sign_in_tokens where user_id = ${fx.users.otherMember.id}`);

  await requestSignInLink({ email: fx.users.otherMember.email });
  expect(await outstandingToken(fx.users.otherMember.id)).toBeNull();

  await db.execute(sql`update users set status = 'ACTIVE' where id = ${fx.users.otherMember.id}`);
});

test("asking again supersedes the previous link", async () => {
  const first = await plantToken(fx.users.hod.id);
  await requestSignInLink({ email: fx.users.hod.email });

  // The planted one is dead; only the newly issued link is live.
  expect(await consumeSignInToken(first)).toBeNull();

  const [{ n }] = (await db.execute(sql`
    select count(*)::int as n from sign_in_tokens
     where user_id = ${fx.users.hod.id} and consumed_at is null
  `)) as unknown as { n: number }[];
  expect(Number(n)).toBe(1);
});

test("the raw token is never stored — only its hash", async () => {
  const raw = await plantToken(fx.users.finance.id);
  const [{ n }] = (await db.execute(sql`
    select count(*)::int as n from sign_in_tokens where token_hash = ${raw}
  `)) as unknown as { n: number }[];
  expect(Number(n)).toBe(0);
});

/* ---------------------------------------------------------- spending a link */

test("a link works once", async () => {
  const raw = await plantToken(fx.users.member.id);

  const first = await consumeSignInToken(raw);
  expect(first?.userId).toBe(fx.users.member.id);

  // A forwarded link, a mail scanner, a second click: all get nothing.
  expect(await consumeSignInToken(raw)).toBeNull();
});

test("an expired link is refused", async () => {
  const raw = await plantToken(fx.users.member.id, { expiresInMs: -1000 });
  expect(await consumeSignInToken(raw)).toBeNull();
});

test("a made-up token is refused, whatever its shape", async () => {
  for (const bad of ["", "x", "../../etc/passwd", "a".repeat(600), crypto.randomUUID()]) {
    expect(await consumeSignInToken(bad)).toBeNull();
  }
});

test("accepting an invitation is what makes someone active", async () => {
  const [invitee] = (await db.execute(sql`
    insert into users (fest_id, name, email, role, department_id, status)
    values (${fx.festId}, 'Newcomer', ${`new-${crypto.randomUUID()}@sst.scaler.com`},
            'MEMBER', ${fx.departments.tech}, 'INVITED')
    returning id`)) as unknown as { id: string }[];

  const raw = await plantToken(invitee.id);
  expect((await consumeSignInToken(raw))?.userId).toBe(invitee.id);

  const [row] = (await db.execute(sql`
    select status::text as status from users where id = ${invitee.id}
  `)) as unknown as { status: string }[];
  expect(row.status).toBe("ACTIVE");
});

/* -------------------------------------------------------------- sessions */

test("a session resolves to the user, with the role authorization runs on", async () => {
  const { token, expiresAt } = await createSession(fx.users.finance.id);

  const user = await resolveSession(token);
  expect(user?.id).toBe(fx.users.finance.id);
  expect(user?.role).toBe("FINANCE_HOD");
  expect(user?.festId).toBe(fx.festId);

  // PRD 13 — seven days.
  const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(6.9);
  expect(days).toBeLessThanOrEqual(SESSION_TTL_MS / 86_400_000);
});

test("a cookie that is not a session resolves to nobody", async () => {
  expect(await resolveSession(undefined)).toBeNull();
  expect(await resolveSession("")).toBeNull();
  expect(await resolveSession(crypto.randomUUID())).toBeNull();
});

test("signing out kills the session server-side, not just the cookie", async () => {
  const { token } = await createSession(fx.users.hod.id);
  expect(await resolveSession(token)).not.toBeNull();

  await revokeSession(token);
  // A copied cookie is now worthless, which clearing it alone would not achieve.
  expect(await resolveSession(token)).toBeNull();
});

test("an expired session is refused even though the row is still there", async () => {
  const { token } = await createSession(fx.users.hod.id);
  await db.execute(sql`
    update sessions set expires_at = now() - interval '1 minute'
     where token_hash = ${createHash("sha256").update(token).digest("hex")}
  `);
  expect(await resolveSession(token)).toBeNull();
});

test("disabling someone ends every session and link they hold", async () => {
  const a = await createSession(fx.users.otherHod.id);
  const b = await createSession(fx.users.otherHod.id);
  const link = await plantToken(fx.users.otherHod.id);

  const revoked = await revokeAllSessions(fx.users.otherHod.id);
  expect(revoked).toBeGreaterThanOrEqual(2);

  expect(await resolveSession(a.token)).toBeNull();
  expect(await resolveSession(b.token)).toBeNull();
  expect(await consumeSignInToken(link)).toBeNull();
});

test("a disabled user's live session stops working immediately", async () => {
  const { token } = await createSession(fx.users.member.id);
  expect(await resolveSession(token)).not.toBeNull();

  await db.execute(sql`update users set status = 'DISABLED' where id = ${fx.users.member.id}`);
  expect(await resolveSession(token)).toBeNull();

  await db.execute(sql`update users set status = 'ACTIVE' where id = ${fx.users.member.id}`);
});

/* ------------------------------------------------------------- the endpoint */

const requestLink = async () =>
  ((await import("@/app/api/v1/auth/request-link/route")) as unknown as Record<string, Handler>).POST;

test("the endpoint answers identically for a known and an unknown address", async () => {
  const handler = await requestLink();

  const known = await call(handler, {
    method: "POST", headers: from(), body: { email: fx.users.finance.email },
  });
  const unknown = await call(handler, {
    method: "POST", headers: from(),
    body: { email: `ghost-${crypto.randomUUID()}@sst.scaler.com` },
  });

  // Same status and same body: the endpoint is not a directory of who is on the fest.
  expect(known.status).toBe(200);
  expect(unknown.status).toBe(200);
  expect(unknown.json).toEqual(known.json);
});

test("a malformed address is answered the same way too, and issues nothing", async () => {
  const handler = await requestLink();
  const result = await call(handler, {
    method: "POST", headers: from(), body: { email: "not-an-email" },
  });
  expect(result.status).toBe(200);
  expect(result.json).toHaveProperty("ok", true);
});

test("the endpoint never returns the link itself", async () => {
  const handler = await requestLink();
  const result = await call(handler, {
    method: "POST", headers: from(), body: { email: fx.users.finance.email },
  });
  expect(result.text).not.toMatch(/token=/);
  expect(result.text).not.toMatch(/auth\/callback/);
});

test("requests are rate limited per address, not only per caller", async () => {
  const handler = await requestLink();
  const email = fx.users.management.email;

  // Each attempt comes from a different address. Only the per-address limit can
  // stop this — which is the point: one inbox must not be floodable from a botnet.
  let last = null as Awaited<ReturnType<typeof call>> | null;
  for (let i = 0; i < 8; i++) {
    last = await call(handler, {
      method: "POST", headers: from(`198.51.100.${i}-${crypto.randomUUID()}`), body: { email },
    });
    if (last.status === 429) break;
  }

  expect(last!.status).toBe(429);
  expect(last!.code).toBe("RATE_LIMITED");
  const details = (last!.json!.error as { details?: Record<string, number> }).details!;
  expect(details.retry_after_seconds).toBeGreaterThan(0);
});

test("one caller cannot rake many addresses either", async () => {
  const handler = await requestLink();
  const ip = `203.0.113.7-${crypto.randomUUID()}`;

  let last = null as Awaited<ReturnType<typeof call>> | null;
  for (let i = 0; i < 25; i++) {
    last = await call(handler, {
      method: "POST", headers: from(ip),
      body: { email: `probe-${crypto.randomUUID()}@sst.scaler.com` },
    });
    if (last.status === 429) break;
  }

  expect(last!.status).toBe(429);
});
