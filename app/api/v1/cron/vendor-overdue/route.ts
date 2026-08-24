import { cronRoute } from "@/lib/cron";
import { runVendorOverdue } from "@/jobs/vendor-overdue";

/** PRD 20.13 — F12 for expected delivery dates that have passed. Hourly. */
export const { GET, POST } = cronRoute("vendor-overdue", runVendorOverdue);
