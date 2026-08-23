/**
 * Fixed-window rate limiting behind the `RATE_LIMITED` error code (PRD 20.1).
 *
 * The window lives in Postgres, not in memory: the app runs as several serverless
 * instances that share no process state, and a limit one instance enforces while
 * another does not is not a limit. One upsert per call, on a two-column primary key.
 *
 * It guards the endpoints where abuse actually costs something — handing out
 * presigned upload URLs, sending invitations, running exports — not every read.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { ApiError } from "@/lib/api";

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
}

export const LIMITS = {
  /** A phone uploading receipts, not a script filling the bucket. */
  upload: { max: 60, windowSeconds: 300 },
  /** Exports scan the whole fest; a handful an hour is generous. */
  export: { max: 20, windowSeconds: 3600 },
  /** Invitations send real email from our domain. */
  invite: { max: 30, windowSeconds: 3600 },
  /** Writes in general — high enough that no honest user meets it. */
  write: { max: 300, windowSeconds: 60 },
} as const satisfies Record<string, Limit>;

export type LimitName = keyof typeof LIMITS;

function windowStart(windowSeconds: number): Date {
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(Date.now() / ms) * ms);
}

/**
 * Counts this call and returns what is left. Consumes the slot whether or not the
 * caller is over the limit, so a client that ignores 429s does not get free retries.
 */
export async function consume(name: LimitName, subject: string): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const limit = LIMITS[name];
  const start = windowStart(limit.windowSeconds);
  const bucket = `${name}:${subject}`;

  // The timestamp is bound as text with an explicit cast: a raw `sql` template hands
  // parameters to postgres-js untyped, and it cannot serialise a JS `Date` that way.
  const [row] = (await db.execute(sql`
    insert into rate_limits (bucket, window_start, count)
    values (${bucket}, ${start.toISOString()}::timestamptz, 1)
    on conflict (bucket, window_start) do update set count = rate_limits.count + 1
    returning count
  `)) as unknown as { count: number }[];

  const count = Number(row?.count ?? 1);
  return {
    allowed: count <= limit.max,
    remaining: Math.max(0, limit.max - count),
    resetAt: new Date(start.getTime() + limit.windowSeconds * 1000),
  };
}

/** Throws the 429 the API contract promises, with the retry hint in `details`. */
export async function enforce(name: LimitName, subject: string): Promise<void> {
  const { allowed, resetAt } = await consume(name, subject);
  if (allowed) return;
  const retryAfter = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
  throw new ApiError("RATE_LIMITED", `Too many requests. Try again in ${retryAfter}s.`, {
    retry_after_seconds: retryAfter,
    limit: LIMITS[name].max,
    window_seconds: LIMITS[name].windowSeconds,
  });
}

/** Housekeeping for the nightly sweep — old windows can never be hit again. */
export async function pruneRateLimits(): Promise<number> {
  const rows = (await db.execute(sql`
    delete from rate_limits where window_start < now() - interval '2 days'
    returning bucket
  `)) as unknown as unknown[];
  return rows.length;
}
