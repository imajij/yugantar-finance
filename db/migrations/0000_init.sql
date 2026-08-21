CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."attachment_kind" AS ENUM('FILE', 'LINK');--> statement-breakpoint
CREATE TYPE "public"."attachment_purpose" AS ENUM('RECEIPT', 'QUOTE', 'LISTING', 'PO', 'INVOICE', 'DELIVERY_PROOF', 'PAYMENT_PROOF', 'MOU', 'TICKET_ATTACHMENT', 'TICKET_PROOF', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."department_kind" AS ENUM('BUDGET', 'FINANCE', 'CORE');--> statement-breakpoint
CREATE TYPE "public"."entity_type" AS ENUM('FEST', 'DEPARTMENT', 'LINE_ITEM', 'REIMBURSEMENT', 'VENDOR', 'VENDOR_REQUEST', 'VENDOR_MILESTONE', 'INCOME_ENTRY', 'BUDGET_TRANSFER', 'TICKET', 'USER', 'ATTACHMENT', 'COMMENT', 'FLAG');--> statement-breakpoint
CREATE TYPE "public"."flag_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."flag_status" AS ENUM('OPEN', 'ACKNOWLEDGED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."income_status" AS ENUM('PLEDGED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'WRITTEN_OFF');--> statement-breakpoint
CREATE TYPE "public"."income_type" AS ENUM('SPONSORSHIP_CASH', 'SPONSORSHIP_IN_KIND', 'EVENT_TICKETS', 'COLLEGE_GRANT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."line_item_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."milestone_kind" AS ENUM('ADVANCE', 'BALANCE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('IN_APP', 'EMAIL', 'PUSH', 'WHATSAPP');--> statement-breakpoint
CREATE TYPE "public"."reimbursement_status" AS ENUM('DRAFT', 'SUBMITTED', 'SENT_BACK', 'HOD_ENDORSED', 'APPROVED', 'ON_HOLD', 'PAID', 'DECLINED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."ticket_priority" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'URGENT');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('OPEN', 'NEEDS_INFO', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'DONE', 'CLOSED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('MEMBER', 'DEPT_HOD', 'FINANCE_HOD', 'MANAGEMENT');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('INVITED', 'ACTIVE', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."vendor_request_status" AS ENUM('DRAFT', 'SUBMITTED', 'SENT_BACK', 'APPROVED', 'ADVANCE_PAID', 'DELIVERED', 'BALANCE_APPROVED', 'CLOSED', 'DECLINED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"entity_type" "entity_type",
	"entity_id" uuid,
	"purpose" "attachment_purpose" NOT NULL,
	"kind" "attachment_kind" NOT NULL,
	"storage_key" text,
	"url" text,
	"file_name" text,
	"mime_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"phash" text,
	"label" text,
	"source_name" text,
	"quoted_amount_paise" bigint,
	"ocr_json" jsonb,
	"uploaded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "attachments_kind_shape" CHECK (("attachments"."kind" = 'FILE' and "attachments"."storage_key" is not null) or ("attachments"."kind" = 'LINK' and "attachments"."url" is not null))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"from_department_id" uuid,
	"to_department_id" uuid,
	"amount_paise" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_transfer_positive" CHECK ("budget_transfers"."amount_paise" > 0),
	CONSTRAINT "budget_transfer_distinct" CHECK ("budget_transfers"."from_department_id" is distinct from "budget_transfers"."to_department_id")
);
--> statement-breakpoint
CREATE TABLE "comment_mentions" (
	"comment_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "comment_mentions_comment_id_user_id_pk" PRIMARY KEY("comment_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "department_kind" DEFAULT 'BUDGET' NOT NULL,
	"allocated_paise" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_fest_slug" UNIQUE("fest_id","slug"),
	CONSTRAINT "departments_alloc_nonneg" CHECK ("departments"."allocated_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "entity_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"from_type" "entity_type" NOT NULL,
	"from_id" uuid NOT NULL,
	"to_type" "entity_type" NOT NULL,
	"to_id" uuid NOT NULL,
	"relation" text DEFAULT 'RELATED' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_links_unique" UNIQUE("from_type","from_id","to_type","to_id")
);
--> statement-breakpoint
CREATE TABLE "expense_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "expense_types_fest_name" UNIQUE("fest_id","name")
);
--> statement-breakpoint
CREATE TABLE "fests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"receipt_window_start" date NOT NULL,
	"receipt_window_end" date NOT NULL,
	"total_budget_paise" bigint DEFAULT 0 NOT NULL,
	"currency" char(3) DEFAULT 'INR' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fests_slug_unique" UNIQUE("slug"),
	CONSTRAINT "fests_budget_nonneg" CHECK ("fests"."total_budget_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"entity_type" "entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"severity" "flag_severity" NOT NULL,
	"explanation" text NOT NULL,
	"status" "flag_status" DEFAULT 'OPEN' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_id_sequences" (
	"fest_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"last_value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "human_id_sequences_fest_id_prefix_pk" PRIMARY KEY("fest_id","prefix")
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"key" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "income_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"type" "income_type" NOT NULL,
	"source_name" text NOT NULL,
	"owning_department_id" uuid,
	"pledged_paise" bigint DEFAULT 0 NOT NULL,
	"pledged_on" date,
	"status" "income_status" DEFAULT 'PLEDGED' NOT NULL,
	"written_off_reason" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "income_pledged_nonneg" CHECK ("income_entries"."pledged_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "income_tranches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"income_entry_id" uuid NOT NULL,
	"amount_paise" bigint NOT NULL,
	"received_on" date NOT NULL,
	"reference" text,
	"recorded_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "income_tranche_positive" CHECK ("income_tranches"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"planned_paise" bigint NOT NULL,
	"default_expense_type_id" uuid,
	"status" "line_item_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"close_reason" text,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "line_items_planned_nonneg" CHECK ("line_items"."planned_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"type" text NOT NULL,
	"entity_type" "entity_type",
	"entity_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"channel" "notification_channel" DEFAULT 'IN_APP' NOT NULL,
	"sent_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reimbursement_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"human_id" text NOT NULL,
	"department_id" uuid NOT NULL,
	"line_item_id" uuid NOT NULL,
	"expense_type_id" uuid NOT NULL,
	"submitter_id" uuid NOT NULL,
	"description" text NOT NULL,
	"transaction_on" date NOT NULL,
	"amount_paise" bigint NOT NULL,
	"merchant" text,
	"payee_name" text NOT NULL,
	"payee_upi_id" text NOT NULL,
	"status" "reimbursement_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"endorsed_by" uuid,
	"endorsed_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"payment_reference" text,
	"last_reason" text,
	"send_back_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "reimbursements_fest_human_id" UNIQUE("fest_id","human_id"),
	CONSTRAINT "reimbursements_description_len" CHECK (char_length("reimbursement_requests"."description") >= 10),
	CONSTRAINT "reimbursements_amount_positive" CHECK ("reimbursement_requests"."amount_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "ticket_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"name" text NOT NULL,
	"target_department_id" uuid,
	"default_priority" "ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_watchers" (
	"ticket_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "ticket_watchers_ticket_id_user_id_pk" PRIMARY KEY("ticket_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"human_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"requesting_department_id" uuid NOT NULL,
	"requester_id" uuid NOT NULL,
	"target_department_id" uuid NOT NULL,
	"assignee_id" uuid,
	"priority" "ticket_priority" DEFAULT 'MEDIUM' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"location" text,
	"estimated_cost_paise" bigint,
	"line_item_id" uuid,
	"status" "ticket_status" DEFAULT 'OPEN' NOT NULL,
	"previous_status" "ticket_status",
	"info_request" text,
	"blocked_reason" text,
	"reject_reason" text,
	"escalated_at" timestamp with time zone,
	"escalated_by" uuid,
	"triage_reminded_at" timestamp with time zone,
	"done_reminded_at" timestamp with time zone,
	"triaged_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"done_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tickets_fest_human_id" UNIQUE("fest_id","human_id"),
	CONSTRAINT "tickets_title_len" CHECK (char_length("tickets"."title") <= 80),
	CONSTRAINT "tickets_cross_department" CHECK ("tickets"."requesting_department_id" <> "tickets"."target_department_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"clerk_user_id" text,
	"email" "citext" NOT NULL,
	"name" text NOT NULL,
	"role" "user_role" NOT NULL,
	"department_id" uuid NOT NULL,
	"upi_id" text,
	"phone" text,
	"status" "user_status" DEFAULT 'INVITED' NOT NULL,
	"digest_opt_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_fest_email" UNIQUE("fest_id","email")
);
--> statement-breakpoint
CREATE TABLE "vendor_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_request_id" uuid NOT NULL,
	"kind" "milestone_kind" NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"planned_paise" bigint NOT NULL,
	"paid_paise" bigint,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"payment_reference" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_milestones_planned_nonneg" CHECK ("vendor_milestones"."planned_paise" >= 0)
);
--> statement-breakpoint
CREATE TABLE "vendor_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"human_id" text NOT NULL,
	"department_id" uuid NOT NULL,
	"line_item_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"description" text NOT NULL,
	"total_value_paise" bigint NOT NULL,
	"approved_value_paise" bigint,
	"expected_delivery_on" date,
	"status" "vendor_request_status" DEFAULT 'DRAFT' NOT NULL,
	"requested_by" uuid NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"delivery_note" text,
	"delivery_confirmed_by" uuid,
	"balance_approved_by" uuid,
	"balance_approved_at" timestamp with time zone,
	"balance_adjust_reason" text,
	"refund_expected_paise" bigint DEFAULT 0 NOT NULL,
	"refund_received_paise" bigint DEFAULT 0 NOT NULL,
	"refund_received_at" timestamp with time zone,
	"last_reason" text,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vendor_requests_fest_human_id" UNIQUE("fest_id","human_id"),
	CONSTRAINT "vendor_requests_total_positive" CHECK ("vendor_requests"."total_value_paise" > 0)
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_name" text,
	"phone" text,
	"email" "citext",
	"bank_account_name" text,
	"bank_account_number" text,
	"bank_ifsc" text,
	"upi_id" text,
	"gstin" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "vendors_fest_name" UNIQUE("fest_id","name")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_from_department_id_departments_id_fk" FOREIGN KEY ("from_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_to_department_id_departments_id_fk" FOREIGN KEY ("to_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_transfers" ADD CONSTRAINT "budget_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_comment_id_comments_id_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_mentions" ADD CONSTRAINT "comment_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_links" ADD CONSTRAINT "entity_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_types" ADD CONSTRAINT "expense_types_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_id_sequences" ADD CONSTRAINT "human_id_sequences_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_owning_department_id_departments_id_fk" FOREIGN KEY ("owning_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_entries" ADD CONSTRAINT "income_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_tranches" ADD CONSTRAINT "income_tranches_income_entry_id_income_entries_id_fk" FOREIGN KEY ("income_entry_id") REFERENCES "public"."income_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "income_tranches" ADD CONSTRAINT "income_tranches_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_default_expense_type_id_expense_types_id_fk" FOREIGN KEY ("default_expense_type_id") REFERENCES "public"."expense_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "line_items" ADD CONSTRAINT "line_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_line_item_id_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."line_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_expense_type_id_expense_types_id_fk" FOREIGN KEY ("expense_type_id") REFERENCES "public"."expense_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_submitter_id_users_id_fk" FOREIGN KEY ("submitter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_endorsed_by_users_id_fk" FOREIGN KEY ("endorsed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reimbursement_requests" ADD CONSTRAINT "reimbursement_requests_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_templates" ADD CONSTRAINT "ticket_templates_target_department_id_departments_id_fk" FOREIGN KEY ("target_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "ticket_watchers_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_watchers" ADD CONSTRAINT "ticket_watchers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requesting_department_id_departments_id_fk" FOREIGN KEY ("requesting_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_target_department_id_departments_id_fk" FOREIGN KEY ("target_department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_line_item_id_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."line_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_escalated_by_users_id_fk" FOREIGN KEY ("escalated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_milestones" ADD CONSTRAINT "vendor_milestones_vendor_request_id_vendor_requests_id_fk" FOREIGN KEY ("vendor_request_id") REFERENCES "public"."vendor_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_milestones" ADD CONSTRAINT "vendor_milestones_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_department_id_departments_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_line_item_id_line_items_id_fk" FOREIGN KEY ("line_item_id") REFERENCES "public"."line_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_delivery_confirmed_by_users_id_fk" FOREIGN KEY ("delivery_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_requests" ADD CONSTRAINT "vendor_requests_balance_approved_by_users_id_fk" FOREIGN KEY ("balance_approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_fest_id_fests_id_fk" FOREIGN KEY ("fest_id") REFERENCES "public"."fests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id") WHERE removed_at is null;--> statement-breakpoint
CREATE INDEX "attachments_sha_idx" ON "attachments" USING btree ("fest_id","sha256") WHERE sha256 is not null;--> statement-breakpoint
CREATE INDEX "attachments_phash_idx" ON "attachments" USING btree ("fest_id","phash") WHERE phash is not null;--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_fest_idx" ON "audit_events" USING btree ("fest_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_entity_idx" ON "comments" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_one_finance" ON "departments" USING btree ("fest_id") WHERE kind = 'FINANCE';--> statement-breakpoint
CREATE UNIQUE INDEX "departments_one_core" ON "departments" USING btree ("fest_id") WHERE kind = 'CORE';--> statement-breakpoint
CREATE UNIQUE INDEX "flags_one_open_per_rule" ON "flags" USING btree ("entity_type","entity_id","rule") WHERE status = 'OPEN';--> statement-breakpoint
CREATE INDEX "income_tranches_entry_idx" ON "income_tranches" USING btree ("income_entry_id");--> statement-breakpoint
CREATE INDEX "line_items_dept_idx" ON "line_items" USING btree ("department_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "notifications_inbox_idx" ON "notifications" USING btree ("recipient_id","read_at","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "reimbursements_fest_status_idx" ON "reimbursement_requests" USING btree ("fest_id","status");--> statement-breakpoint
CREATE INDEX "reimbursements_dept_status_idx" ON "reimbursement_requests" USING btree ("department_id","status");--> statement-breakpoint
CREATE INDEX "reimbursements_line_item_idx" ON "reimbursement_requests" USING btree ("line_item_id");--> statement-breakpoint
CREATE INDEX "reimbursements_submitter_idx" ON "reimbursement_requests" USING btree ("submitter_id");--> statement-breakpoint
CREATE INDEX "reimbursements_payee_idx" ON "reimbursement_requests" USING btree ("fest_id","payee_upi_id");--> statement-breakpoint
CREATE INDEX "reimbursements_dup_idx" ON "reimbursement_requests" USING btree ("fest_id","amount_paise","transaction_on","merchant");--> statement-breakpoint
CREATE INDEX "tickets_inbox_idx" ON "tickets" USING btree ("target_department_id","status","priority","due_at");--> statement-breakpoint
CREATE INDEX "tickets_outgoing_idx" ON "tickets" USING btree ("requesting_department_id","status");--> statement-breakpoint
CREATE INDEX "tickets_assignee_idx" ON "tickets" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "users_fest_role_dept_idx" ON "users" USING btree ("fest_id","role","department_id");--> statement-breakpoint
CREATE INDEX "vendor_milestones_request_idx" ON "vendor_milestones" USING btree ("vendor_request_id");--> statement-breakpoint
CREATE INDEX "vendor_requests_fest_status_idx" ON "vendor_requests" USING btree ("fest_id","status");--> statement-breakpoint
CREATE INDEX "vendor_requests_vendor_idx" ON "vendor_requests" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_requests_line_item_idx" ON "vendor_requests" USING btree ("line_item_id");