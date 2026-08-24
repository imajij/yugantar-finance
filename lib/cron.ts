/**
 * The guard on `/api/v1/cron/*` (PRD 18.1, 20.1).
 *
 * A cron runner has no user, so there is no session to check — the shared secret is
 * the whole authentication. Two details that matter:
 *   - The comparison is constant-time. A timing oracle on a bearer token is a real
 *     way to recover it.
 *   - An unset `CRON_SECRET` fails closed. A deployment that forgot the variable
 *     gets 403s, not open cron endpoints.
 *
 * Vercel Cron issues GET; the PRD writes these as POST. Both are accepted, because
 * the jobs are idempotent and arguing about the verb helps nobody.
 */
import { timingSafeEqual } from "node:crypto";
import { errorResponse } from "@/lib/api";
import { env } from "@/lib/env";
import type { JobResult } from "@/jobs";

function authorized(request: Request): boolean {
  const secret = env("CRON_SECRET");
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Wraps a job as a route handler for both GET and POST. */
export function cronRoute(name: string, job: () => Promise<JobResult>) {
  const handler = async (request: Request) => {
    if (!authorized(request)) {
      return errorResponse("FORBIDDEN", "Cron secret missing or wrong");
    }
    const startedAt = Date.now();
    try {
      const result = await job();
      return Response.json({ job: name, ok: true, ms: Date.now() - startedAt, ...result });
    } catch (error) {
      // A failing job must return 500 so the runner's own alerting fires; the
      // message is logged rather than returned, because cron output is not private.
      console.error(`[cron:${name}] failed`, error);
      return Response.json(
        { job: name, ok: false, error: { code: "INTERNAL", message: "Job failed" } },
        { status: 500 },
      );
    }
  };
  return { GET: handler, POST: handler };
}
