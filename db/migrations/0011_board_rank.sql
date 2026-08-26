-- Where a ticket sits in its column.
--
-- The board has always ordered by priority then due date, which is a sensible
-- default and not a plan: the thing a team actually does on a board is drag the
-- three that matter to the top. That order has to be stored, because it is a
-- decision somebody made rather than a property of the ticket.
--
-- A float rather than an integer, so dropping a card between two others is one
-- UPDATE (the midpoint) instead of renumbering the column. Ties fall back to the
-- old ordering, so a fest that never drags anything sees no change at all.
ALTER TABLE "tickets" ADD COLUMN "board_rank" double precision;--> statement-breakpoint

CREATE INDEX "tickets_rank_idx" ON "tickets" ("status", "board_rank")
  WHERE "deleted_at" IS NULL;
