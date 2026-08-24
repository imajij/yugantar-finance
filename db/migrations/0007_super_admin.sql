ALTER TABLE "users" ADD COLUMN "is_super_admin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A fest with no administrator has nobody who can appoint one, so every existing
-- Finance HOD becomes one. New fests get theirs from the bootstrap seed instead.
UPDATE "users" SET "is_super_admin" = true WHERE "role" = 'FINANCE_HOD';
