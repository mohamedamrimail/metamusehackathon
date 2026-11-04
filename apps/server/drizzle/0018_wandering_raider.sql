ALTER TABLE "invite_codes" ADD COLUMN "kind" text DEFAULT 'invite' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_kind" text DEFAULT 'user' NOT NULL;