-- Allocation requests, hand-raised flags, and the Linear-shaped ticket board.
--
-- Enum values are added first and never used below: Postgres allows ALTER TYPE ...
-- ADD VALUE inside a transaction, but not using the new label in that same
-- transaction, and drizzle wraps each migration in one.

ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'ALLOCATION_REQUEST';--> statement-breakpoint
ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'TICKET_LABEL';--> statement-breakpoint
ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'PROJECT';--> statement-breakpoint
ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'CYCLE';--> statement-breakpoint

-- Linear's Backlog/Todo split. ACCEPTED is Todo — triaged and ready to start;
-- BACKLOG is triaged and deliberately not scheduled yet.
ALTER TYPE "ticket_status" ADD VALUE IF NOT EXISTS 'BACKLOG';--> statement-breakpoint

/* ------------------------------------------------------- allocation requests */

CREATE TYPE "allocation_request_status" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'WITHDRAWN');--> statement-breakpoint

CREATE TABLE "allocation_requests" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fest_id"         uuid NOT NULL REFERENCES "fests"("id"),
  "department_id"   uuid NOT NULL REFERENCES "departments"("id"),
  -- The allocation the HOD is asking for, and what it was when they asked. Both are
  -- kept so a request approved a week later can still be read honestly.
  "requested_paise" bigint NOT NULL,
  "current_paise"   bigint NOT NULL,
  "reason"          text NOT NULL,
  "status"          "allocation_request_status" DEFAULT 'PENDING' NOT NULL,
  "requested_by"    uuid NOT NULL REFERENCES "users"("id"),
  "decided_by"      uuid REFERENCES "users"("id"),
  "decided_at"      timestamp with time zone,
  "decision_note"   text,
  -- The transfer the approval actually made. An allocation only ever moves by
  -- transfer (7.1), so this is the link from the ask to the money.
  "transfer_id"     uuid REFERENCES "budget_transfers"("id"),
  "created_at"      timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"      timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "allocation_requests_nonneg" CHECK ("requested_paise" >= 0)
);--> statement-breakpoint

-- One open ask per department: a queue of five revisions of the same request is
-- noise, and the HOD can withdraw and re-raise.
CREATE UNIQUE INDEX "allocation_requests_one_pending"
  ON "allocation_requests" ("department_id") WHERE "status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "allocation_requests_fest_idx"
  ON "allocation_requests" ("fest_id", "status", "created_at");--> statement-breakpoint

/* ------------------------------------------------------------- manual flags */

-- Who raised it by hand. NULL means a rule did, which is every flag until now.
ALTER TABLE "flags" ADD COLUMN "raised_by" uuid REFERENCES "users"("id");--> statement-breakpoint

-- The one-open-flag-per-rule guard exists so a rule re-running cannot pile up
-- duplicates. Hand-raised flags are the opposite case: two people noticing two
-- different things about one record is exactly what should be allowed.
DROP INDEX IF EXISTS "flags_one_open_per_rule";--> statement-breakpoint
CREATE UNIQUE INDEX "flags_one_open_per_rule"
  ON "flags" ("entity_type", "entity_id", "rule")
  WHERE "status" = 'OPEN' AND "raised_by" IS NULL;--> statement-breakpoint

/* --------------------------------------------------- projects, cycles, labels */

CREATE TYPE "project_status" AS ENUM ('PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint

CREATE TABLE "projects" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fest_id"     uuid NOT NULL REFERENCES "fests"("id"),
  "name"        text NOT NULL,
  "description" text,
  "status"      "project_status" DEFAULT 'PLANNED' NOT NULL,
  "lead_id"     uuid REFERENCES "users"("id"),
  "starts_on"   date,
  "ends_on"     date,
  "created_by"  uuid NOT NULL REFERENCES "users"("id"),
  "created_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"  timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at"  timestamp with time zone,
  CONSTRAINT "projects_fest_name" UNIQUE ("fest_id", "name")
);--> statement-breakpoint

-- A cycle is a fixed window everyone plans against — "setup week", "fest days".
CREATE TABLE "cycles" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fest_id"    uuid NOT NULL REFERENCES "fests"("id"),
  "name"       text NOT NULL,
  "starts_on"  date NOT NULL,
  "ends_on"    date NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cycles_fest_name" UNIQUE ("fest_id", "name"),
  CONSTRAINT "cycles_dates" CHECK ("ends_on" >= "starts_on")
);--> statement-breakpoint

CREATE TABLE "ticket_labels" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fest_id"    uuid NOT NULL REFERENCES "fests"("id"),
  "name"       text NOT NULL,
  -- A hex colour chosen from a fixed palette in the UI; stored so a label reads the
  -- same everywhere it appears.
  "color"      text DEFAULT '#8b8ba7' NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ticket_labels_fest_name" UNIQUE ("fest_id", "name"),
  CONSTRAINT "ticket_labels_color" CHECK ("color" ~ '^#[0-9a-fA-F]{6}$')
);--> statement-breakpoint

CREATE TABLE "ticket_label_links" (
  "ticket_id" uuid NOT NULL REFERENCES "tickets"("id"),
  "label_id"  uuid NOT NULL REFERENCES "ticket_labels"("id") ON DELETE CASCADE,
  CONSTRAINT "ticket_label_links_pk" PRIMARY KEY ("ticket_id", "label_id")
);--> statement-breakpoint
CREATE INDEX "ticket_label_links_label_idx" ON "ticket_label_links" ("label_id");--> statement-breakpoint

/* ------------------------------------------------------- tickets: the new axes */

ALTER TABLE "tickets" ADD COLUMN "parent_id" uuid REFERENCES "tickets"("id");--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "project_id" uuid REFERENCES "projects"("id");--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "cycle_id" uuid REFERENCES "cycles"("id");--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_not_own_parent" CHECK ("parent_id" IS DISTINCT FROM "id");--> statement-breakpoint

CREATE INDEX "tickets_parent_idx" ON "tickets" ("parent_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tickets_project_idx" ON "tickets" ("project_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tickets_cycle_idx" ON "tickets" ("cycle_id") WHERE "deleted_at" IS NULL;
