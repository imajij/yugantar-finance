import { cronRoute } from "@/lib/cron";
import { runIncomeFollowups } from "@/jobs/income-followups";

/** PRD 20.13 — pledges unreceived past `income_followup_days`. Daily. */
export const { GET, POST } = cronRoute("income-followups", runIncomeFollowups);
