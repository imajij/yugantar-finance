import { cronRoute } from "@/lib/cron";
import { runGcAttachments } from "@/jobs/gc-attachments";

/** PRD 20.13 — uploads that never found a parent, plus spent rate-limit windows. Daily. */
export const { GET, POST } = cronRoute("gc-attachments", runGcAttachments);
