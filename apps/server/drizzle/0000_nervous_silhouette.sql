CREATE TYPE "public"."action_status" AS ENUM('proposed', 'confirmed', 'rejected', 'expired', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('web', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."connection_kind" AS ENUM('google_calendar', 'gmail', 'mcp');--> statement-breakpoint
CREATE TYPE "public"."fact_category" AS ENUM('preference', 'routine', 'goal', 'constraint', 'contact');--> statement-breakpoint
CREATE TYPE "public"."fact_source" AS ENUM('onboarding', 'conversation', 'user_edit');--> statement-breakpoint
CREATE TYPE "public"."risk" AS ENUM('read', 'write', 'money');--> statement-breakpoint
CREATE TABLE "actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"conversation_id" uuid,
	"tool" text NOT NULL,
	"args" jsonb NOT NULL,
	"risk" "risk" NOT NULL,
	"status" "action_status" DEFAULT 'proposed' NOT NULL,
	"summary" text NOT NULL,
	"amount_cents" bigint,
	"currency" text,
	"result" jsonb,
	"confirm_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "actions_confirm_token_unique" UNIQUE("confirm_token")
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"title" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"kind" "connection_kind" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_enc" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"channel" "channel" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ipersons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"avatar_mouth_url" text,
	"voice_id" text,
	"persona_style" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigserial NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"audio_url" text,
	"tool_calls" jsonb,
	"meta_response_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"qty" numeric NOT NULL,
	"avg_price" numeric NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"pnl" numeric,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"category" "fact_category" NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"source" "fact_source" DEFAULT 'conversation' NOT NULL,
	"confidence" real DEFAULT 0.8 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"phone_e164" text,
	"name" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"timezone" text DEFAULT 'Africa/Tunis' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_e164_unique" UNIQUE("phone_e164")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'TND' NOT NULL,
	"per_action_limit_cents" bigint DEFAULT 5000 NOT NULL,
	"monthly_budget_cents" bigint DEFAULT 50000 NOT NULL,
	"spent_this_month_cents" bigint DEFAULT 0 NOT NULL,
	"spent_month" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallets_iperson_id_unique" UNIQUE("iperson_id")
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipersons" ADD CONSTRAINT "ipersons_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD CONSTRAINT "profile_facts_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_iperson_idx" ON "actions" USING btree ("iperson_id","status");--> statement-breakpoint
CREATE INDEX "calendar_events_range_idx" ON "calendar_events" USING btree ("iperson_id","starts_at");--> statement-breakpoint
CREATE INDEX "conversations_iperson_idx" ON "conversations" USING btree ("iperson_id","channel");--> statement-breakpoint
CREATE INDEX "ipersons_user_idx" ON "ipersons" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_facts_key_uq" ON "profile_facts" USING btree ("iperson_id","category","key");