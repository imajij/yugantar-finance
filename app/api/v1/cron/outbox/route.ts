import { cronRoute } from "@/lib/cron";
import { recordRun } from "@/jobs";
import { flushOutbox } from "@/lib/services/notifications";

/**
 * The retry pass over the email outbox.
 *
 * Notifications are normally sent immediately after the write that caused them
 * (see `lib/api.ts`). This exists for the ones that did not go out — a provider
 * outage, a deploy mid-request — so a failed send costs a delay rather than a
 * lost message.
 */
export const { GET, POST } = cronRoute("outbox", async () => {
  const result = await flushOutbox(200);
  await recordRun("outbox", result);
  return result;
});
