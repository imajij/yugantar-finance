import { cronRoute } from "@/lib/cron";
import { runDailyDigest } from "@/jobs/daily-digest";

/** PRD 10 / 20.13 — pending decisions, open flags and overdue items. Daily. */
export const { GET, POST } = cronRoute("daily-digest", runDailyDigest);
