/**
 * PRD 20.13 `/cron/gc-attachments` — uploads that never found a parent.
 *
 * The presign flow (20.2) hands out a URL before the record exists, so an abandoned
 * form leaves a file in a private bucket that nothing references and nobody can
 * reach. Twenty-four hours is longer than any create flow, and section 11's
 * retention rule is about records people can see — this is about the ones nobody can.
 */
import { pruneAuth } from "@/lib/auth";
import { collectOrphanedUploads } from "@/lib/services/attachments";
import { pruneRateLimits } from "@/lib/rate-limit";
import { recordRun, type JobResult } from "./index";

export async function runGcAttachments(): Promise<JobResult> {
  const { deleted } = await collectOrphanedUploads(24);
  // Old rate-limit windows can never be hit again; they are pure table growth.
  const rateLimitRows = await pruneRateLimits();
  // Spent sign-in links and long-dead sessions. Expiry is enforced in the query that
  // reads them, so this is housekeeping rather than a control.
  const auth = await pruneAuth();

  const result = {
    orphaned_uploads_removed: deleted,
    rate_limit_rows_pruned: rateLimitRows,
    sessions_pruned: auth.sessions,
    sign_in_tokens_pruned: auth.tokens,
  };
  await recordRun("gc-attachments", result);
  return result;
}
