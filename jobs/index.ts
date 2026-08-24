/**
 * Scheduled work (PRD 18.1, 20.13).
 *
 * Everything here exists because some conditions become true when nothing is
 * written: a delivery date passes, a ticket nobody triaged goes stale, a pledge
 * ages past the follow-up window. No user action can trigger those, so a clock does.
 *
 * Two properties every job here holds to:
 *   - **Idempotent.** Cron runners retry. Each job records what it has already
 *     acted on (`triage_reminded_at`, `followup_reminded_at`, …) and skips it next
 *     time, so running a job twice sends one reminder, not two.
 *   - **Bounded.** Every query has a limit. A job that wakes up to a backlog of
 *     10,000 rows must not take the database with it.
 */
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { cronRuns } from "@/db/schema";

export interface JobResult {
  [key: string]: number | string | undefined;
}

/** Records the run so the daily digest can cover exactly the window since the last one. */
export async function recordRun(job: string, result: JobResult): Promise<void> {
  await db.insert(cronRuns)
    .values({ job, lastRunAt: new Date(), lastResult: result })
    .onConflictDoUpdate({
      target: cronRuns.job,
      set: { lastRunAt: new Date(), lastResult: result },
    });
}

export async function lastRunOf(job: string): Promise<Date | null> {
  const [row] = (await db.execute(sql`
    select last_run_at from cron_runs where job = ${job}
  `)) as unknown as { last_run_at: Date }[];
  return row?.last_run_at ?? null;
}
