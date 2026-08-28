-- Idempotency keys become a reservation, not a receipt.
--
-- The key was written *after* the handler finished, so it recorded what had already
-- happened rather than claiming the right to make it happen. Two requests carrying
-- the same key both found no row, both ran, and the loser's response was dropped by
-- `on conflict do nothing` — so a double-click or a retry on a flaky connection
-- produced two payments and told the caller about one.
--
-- Two columns make the row a claim instead:
--
--   `response` becomes nullable, and NULL now means *in flight*. The row is inserted
--   before the handler runs; whoever wins the unique index owns the work, and
--   everyone else either waits or replays.
--
--   `fingerprint` binds the key to the request that created it. Without it, reusing
--   a key on a different route replays an unrelated response — a caller asking to
--   pay RB-2 could be handed the stored result of paying RB-1 and told it worked.
ALTER TABLE "idempotency_keys" ALTER COLUMN "response" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD COLUMN "fingerprint" text;--> statement-breakpoint

-- A reservation whose request died leaves NULL forever and burns the key. This is
-- what lets one be reclaimed once it is plainly abandoned, without a cron job to
-- forget to schedule.
CREATE INDEX "idempotency_keys_pending_idx" ON "idempotency_keys" ("created_at")
  WHERE "response" IS NULL;
