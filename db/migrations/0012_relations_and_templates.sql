-- Issue relations, and templates for raising a ticket.
--
-- Relations reuse `entity_links`, which has carried a `relation` column since the
-- start and only ever held two values. The vocabulary is now constrained, because
-- a relation nothing knows how to render is a row that exists and shows up
-- nowhere — the worst kind of data.
--
-- Direction is stored once, never twice. "A blocks B" is one row; B's page draws
-- "blocked by A" by reading that same row from the other end. Two rows for one
-- fact is two rows that can disagree.
ALTER TABLE "entity_links"
  ADD CONSTRAINT "entity_links_relation" CHECK (
    "relation" IN ('RELATED', 'BLOCKS', 'DUPLICATES', 'MENTIONED_IN')
  );--> statement-breakpoint

-- Both ends are read constantly — a ticket page asks "what do I point at" and
-- "what points at me" — and neither had an index.
CREATE INDEX "entity_links_to_idx" ON "entity_links" ("to_type", "to_id");--> statement-breakpoint
CREATE INDEX "entity_links_from_idx" ON "entity_links" ("from_type", "from_id");--> statement-breakpoint

-- `ticket_templates` has existed since 0000 and has never been written to: no
-- service, no endpoint, no screen. What it was missing was everything a template
-- has to carry to save anybody typing, plus the columns this repo requires of any
-- table somebody can change (who made it, when it last moved).
--
-- Added rather than replaced, because migrations here are additive and run on
-- every deploy. `fields` stays for the same reason — nothing reads it, and
-- dropping a column is not a thing this file is allowed to do.
--
-- `created_by` is nullable. It should not be, and would not be in a new table;
-- but backfilling a NOT NULL onto a table that *might* hold a row somewhere is
-- how a deploy fails at 2am for a column nobody was using.
ALTER TABLE "ticket_templates"
  ADD COLUMN "summary" text,
  ADD COLUMN "title" text,
  ADD COLUMN "body" text,
  ADD COLUMN "location" text,
  ADD COLUMN "estimated_cost_paise" bigint,
  -- Relative, because a template outlives any particular date. "Needed within 48
  -- hours" still means something in November; "needed on the 3rd" does not.
  ADD COLUMN "due_in_hours" integer,
  ADD COLUMN "project_id" uuid REFERENCES "projects"("id"),
  ADD COLUMN "cycle_id" uuid REFERENCES "cycles"("id"),
  ADD COLUMN "created_by" uuid REFERENCES "users"("id"),
  ADD COLUMN "created_at" timestamptz DEFAULT now() NOT NULL,
  ADD COLUMN "updated_at" timestamptz DEFAULT now() NOT NULL;--> statement-breakpoint

ALTER TABLE "ticket_templates"
  ADD CONSTRAINT "ticket_templates_due_in_hours" CHECK (
    "due_in_hours" IS NULL OR ("due_in_hours" > 0 AND "due_in_hours" <= 8760)
  ),
  ADD CONSTRAINT "ticket_templates_cost_nonneg" CHECK (
    "estimated_cost_paise" IS NULL OR "estimated_cost_paise" >= 0
  );--> statement-breakpoint

CREATE UNIQUE INDEX "ticket_templates_name" ON "ticket_templates" ("fest_id", lower("name"))
  WHERE "is_active";--> statement-breakpoint
CREATE INDEX "ticket_templates_fest_idx" ON "ticket_templates" ("fest_id", "is_active");--> statement-breakpoint

-- Cascading, unlike `ticket_label_links`: a template is disposable in a way a
-- ticket is not, and a retired label must not leave a template pointing at
-- nothing.
CREATE TABLE "ticket_template_labels" (
  "template_id" uuid NOT NULL REFERENCES "ticket_templates"("id") ON DELETE CASCADE,
  "label_id" uuid NOT NULL REFERENCES "ticket_labels"("id") ON DELETE CASCADE,
  PRIMARY KEY ("template_id", "label_id")
);--> statement-breakpoint

ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'TICKET_TEMPLATE';
