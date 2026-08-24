import { cronRoute } from "@/lib/cron";
import { recordRun, type JobResult } from "@/jobs";
import { runDailyDigest } from "@/jobs/daily-digest";
import { runGcAttachments } from "@/jobs/gc-attachments";
import { runIncomeFollowups } from "@/jobs/income-followups";
import { runTicketSla } from "@/jobs/ticket-sla";
import { runVendorOverdue } from "@/jobs/vendor-overdue";
import { flushOutbox } from "@/lib/services/notifications";

/**
 * Every scheduled job, in one request.
 *
 * Vercel's Hobby plan runs cron jobs at most once a day, so six entries at six
 * cadences is not deployable there. This is the whole set behind one path, which a
 * single daily trigger can drive — the individual endpoints stay, for a plan or a
 * scheduler that can call them more often (see `infra/README.md`).
 *
 * One job failing must not stop the rest: they are independent, and a vendor query
 * erroring is no reason for the day's digest not to go out. Each result is reported
 * separately, and the response is a failure only if something actually failed —
 * a green cron run that quietly did nothing is worse than a red one.
 */
const JOBS: [string, () => Promise<JobResult>][] = [
  ["ticket-sla", runTicketSla],
  ["vendor-overdue", runVendorOverdue],
  ["income-followups", runIncomeFollowups],
  ["daily-digest", runDailyDigest],
  ["gc-attachments", runGcAttachments],
  ["outbox", async () => flushOutbox(200)],
];

export const { GET, POST } = cronRoute("all", async () => {
  const results: Record<string, unknown> = {};
  const failed: string[] = [];

  for (const [name, run] of JOBS) {
    const startedAt = Date.now();
    try {
      results[name] = { ok: true, ms: Date.now() - startedAt, ...(await run()) };
    } catch (error) {
      failed.push(name);
      console.error(`[cron:all] ${name} failed`, error);
      results[name] = {
        ok: false,
        ms: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  await recordRun("all", { jobs: JOBS.length, failed: failed.length });

  // `cronRoute` turns a throw into a 500, which is what makes the runner's own
  // alerting fire. The per-job detail is already in the log by this point.
  if (failed.length) throw new Error(`${failed.join(", ")} failed`);
  return results as JobResult;
});
