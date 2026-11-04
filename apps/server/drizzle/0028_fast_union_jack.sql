ALTER TABLE "invite_codes" ADD COLUMN "cohort" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "cohort" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "referral" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chain_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chain_completed_at" timestamp with time zone;