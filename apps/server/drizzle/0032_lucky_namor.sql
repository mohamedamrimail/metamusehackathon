ALTER TABLE "waitlist" ADD COLUMN "share_code" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD COLUMN "referred_by" text;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_share_code_unique" UNIQUE("share_code");