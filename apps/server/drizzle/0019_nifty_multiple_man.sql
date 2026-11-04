DROP INDEX "profile_facts_key_uq";--> statement-breakpoint
ALTER TABLE "iperson_rules" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "iperson_rules" ADD COLUMN "source_hint" text;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "source_hint" text;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_facts_key_uq" ON "profile_facts" USING btree ("iperson_id","category","key","status");