CREATE TABLE "cron_runs" (
	"job" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_result" jsonb
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_bucket_window_start_pk" PRIMARY KEY("bucket","window_start")
);
--> statement-breakpoint
ALTER TABLE "income_entries" ADD COLUMN "followup_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "triage_escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "due_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tickets" ADD COLUMN "auto_closed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "notifications_outbox_idx" ON "notifications" USING btree ("channel","created_at") WHERE sent_at is null and failed_at is null;