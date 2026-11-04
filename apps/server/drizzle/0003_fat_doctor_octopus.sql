CREATE TYPE "public"."ai_usage_kind" AS ENUM('llm', 'stt', 'image', 'sam');--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "ai_usage_kind" NOT NULL,
	"model" text NOT NULL,
	"units" jsonb NOT NULL,
	"meta_cost_micros" bigint NOT NULL,
	"fee_micros" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ai_credit_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_user_idx" ON "ai_usage" USING btree ("user_id","created_at");--> statement-breakpoint
-- Existing accounts get the launch free credit ($5) too; new ones get AI_FREE_CREDIT_USD at sign-up.
UPDATE "users" SET "ai_credit_micros" = 5000000;
