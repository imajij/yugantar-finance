-- Department channels and direct messages.
--
-- The rule this table layout exists to enforce: a channel's audience is its
-- membership row, and nothing else. A department's HOD cannot reach another
-- department's channel because they are not in it — not because a role check said
-- no, which is a thing that can be forgotten at one call site out of twelve.
--
-- The single exception is the administrator, who reads every channel. That is
-- deliberate and it is disclosed in the channel header; every such read is written
-- to `audit_events` as `channel.oversight_read`, so the oversight is itself
-- overseen.
--
-- Enum values are added first and never used below: Postgres allows ALTER TYPE ...
-- ADD VALUE inside a transaction, but not using the new label in that same
-- transaction, and drizzle wraps each migration in one.

ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'CHANNEL';--> statement-breakpoint
ALTER TYPE "entity_type" ADD VALUE IF NOT EXISTS 'MESSAGE';--> statement-breakpoint
ALTER TYPE "attachment_purpose" ADD VALUE IF NOT EXISTS 'CHAT_ATTACHMENT';--> statement-breakpoint

CREATE TYPE "channel_kind" AS ENUM ('DEPARTMENT', 'DIRECT');--> statement-breakpoint

CREATE TABLE "channels" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fest_id"       uuid NOT NULL REFERENCES "fests"("id"),
  "kind"          "channel_kind" NOT NULL,
  -- Set for DEPARTMENT channels; NULL for direct messages.
  "department_id" uuid REFERENCES "departments"("id"),
  "name"          text,
  "topic"         text,
  -- The channel a department gets on creation, which cannot be archived or renamed
  -- away: it is where somebody new is guaranteed to land.
  "is_default"    boolean DEFAULT false NOT NULL,
  -- The two participants of a direct message, sorted and joined, so opening the
  -- same conversation twice finds the one that already exists rather than making a
  -- second. NULL for department channels.
  "direct_key"    text,
  "created_by"    uuid NOT NULL REFERENCES "users"("id"),
  "created_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "archived_at"   timestamp with time zone,
  "archived_by"   uuid REFERENCES "users"("id"),
  CONSTRAINT "channels_shape" CHECK (
    (kind = 'DEPARTMENT' AND department_id IS NOT NULL AND name IS NOT NULL AND direct_key IS NULL)
    OR
    (kind = 'DIRECT' AND department_id IS NULL AND name IS NULL AND direct_key IS NOT NULL)
  )
);--> statement-breakpoint

CREATE UNIQUE INDEX "channels_direct_key" ON "channels" ("fest_id", "direct_key")
  WHERE "direct_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_department_name" ON "channels" ("department_id", lower("name"))
  WHERE "department_id" IS NOT NULL AND "archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "channels_one_default" ON "channels" ("department_id")
  WHERE "is_default" AND "archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "channels_fest_idx" ON "channels" ("fest_id", "kind");--> statement-breakpoint

CREATE TABLE "channel_members" (
  "channel_id"      uuid NOT NULL REFERENCES "channels"("id"),
  "user_id"         uuid NOT NULL REFERENCES "users"("id"),
  -- Where this person has read up to. The unread count is everything after it.
  "last_read_at"    timestamp with time zone,
  "muted"           boolean DEFAULT false NOT NULL,
  "joined_at"       timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "channel_members_pk" PRIMARY KEY ("channel_id", "user_id")
);--> statement-breakpoint
CREATE INDEX "channel_members_user_idx" ON "channel_members" ("user_id");--> statement-breakpoint

CREATE TABLE "messages" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fest_id"    uuid NOT NULL REFERENCES "fests"("id"),
  "channel_id" uuid NOT NULL REFERENCES "channels"("id"),
  "author_id"  uuid NOT NULL REFERENCES "users"("id"),
  "body"       text NOT NULL,
  -- A thread reply points at the message it answers. One level: a reply to a reply
  -- belongs to the same thread.
  "parent_id"  uuid REFERENCES "messages"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "edited_at"  timestamp with time zone,
  -- Soft, per 18.2 rule 7. A deleted message leaves its row and shows as removed.
  "deleted_at" timestamp with time zone,
  CONSTRAINT "messages_body_len" CHECK (char_length("body") <= 4000),
  CONSTRAINT "messages_not_own_parent" CHECK ("parent_id" IS DISTINCT FROM "id")
);--> statement-breakpoint

CREATE INDEX "messages_channel_idx" ON "messages" ("channel_id", "created_at" DESC);--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" ("parent_id", "created_at")
  WHERE "parent_id" IS NOT NULL;--> statement-breakpoint

CREATE TABLE "message_mentions" (
  "message_id" uuid NOT NULL REFERENCES "messages"("id"),
  "user_id"    uuid NOT NULL REFERENCES "users"("id"),
  CONSTRAINT "message_mentions_pk" PRIMARY KEY ("message_id", "user_id")
);--> statement-breakpoint
CREATE INDEX "message_mentions_user_idx" ON "message_mentions" ("user_id");
