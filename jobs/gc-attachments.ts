/**
 * PRD 20.13 `/cron/gc-attachments` — uploads that never found a parent.
 *
 * The presign flow (20.2) hands out a URL before the record exists, so an abandoned
 * form leaves a file in a private bucket that nothing references and nobody can
 * reach. Twenty-four hours is longer than any create flow, and section 11's
 * retention rule is about records people can see — this is about the ones nobody can.
 */
import { collectOrphanedUploads } from "@/lib/services/attachments";
import { pruneRateLimits } from "@/lib/rate-limit";
import { recordRun, type JobResult } from "./index";

export async function runGcAttachments(): Promise<JobResult> {
  const { deleted } = await collectOrphanedUploads(24);
  // Old rate-limit windows can never be hit again; they are pure table growth.
  const rateLimitRows = await pruneRateLimits();

  const result = { orphaned_uploads_removed: deleted, rate_limit_rows_pruned: rateLimitRows };
  await recordRun("gc-attachments", result);
  return result;
}
