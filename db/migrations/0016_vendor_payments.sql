-- Vendor milestones can be paid in more than one transfer (PRD 7.3).
--
-- A milestone used to be paid exactly once, in full, and its row carried that one
-- payment's date, payer and reference. Paying part of it now and the rest later
-- needs somewhere to keep each transfer, with its own reference and its own
-- receipt, so every payment is a row here.
--
-- The milestone keeps what the rest of the system already reads:
--   paid_paise  the running total paid on it (what 0001_views.sql sums for Spent),
--   paid_at     set only once the milestone is fully paid — "settled", which is
--               what every `paid_at is null` reader has always meant by "still owed",
--   paid_by / payment_reference  of the payment that settled it.
CREATE TABLE "vendor_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fest_id" uuid NOT NULL REFERENCES "fests"("id"),
	"vendor_request_id" uuid NOT NULL REFERENCES "vendor_requests"("id"),
	"milestone_id" uuid NOT NULL REFERENCES "vendor_milestones"("id"),
	"amount_paise" bigint NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	-- Nullable only for the rows carried over below, from milestones paid before
	-- anybody recorded who paid them. Every new payment names its payer.
	"paid_by" uuid REFERENCES "users"("id"),
	"payment_reference" text NOT NULL,
	"proof_attachment_id" uuid REFERENCES "attachments"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_payments_amount_positive" CHECK ("amount_paise" > 0)
);
--> statement-breakpoint
CREATE INDEX "vendor_payments_request_idx" ON "vendor_payments" ("vendor_request_id");
--> statement-breakpoint
CREATE INDEX "vendor_payments_milestone_idx" ON "vendor_payments" ("milestone_id");
--> statement-breakpoint
-- Every milestone already paid was paid once and in full, so each becomes one row.
INSERT INTO "vendor_payments"
	("fest_id", "vendor_request_id", "milestone_id", "amount_paise", "paid_at", "paid_by", "payment_reference", "created_at")
SELECT vr."fest_id", m."vendor_request_id", m."id", m."paid_paise",
       coalesce(m."paid_at", m."updated_at"), m."paid_by", coalesce(m."payment_reference", '—'),
       coalesce(m."paid_at", m."updated_at")
  FROM "vendor_milestones" m
  JOIN "vendor_requests" vr ON vr."id" = m."vendor_request_id"
 WHERE m."paid_paise" > 0;
