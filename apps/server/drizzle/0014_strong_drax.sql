CREATE TYPE "public"."fact_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid,
	"reason" text NOT NULL,
	"reporter_contact" text,
	"ip_hash" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"visitor_name" text NOT NULL,
	"visitor_email" text,
	"visitor_phone" text,
	"ip_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "visitor_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "scope" text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "handle" text;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "public_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "public_greeting" text;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "public_bio" text;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "visitor_allow" jsonb DEFAULT '{"answer":true,"messages":true,"meetings":true}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "open_to_jobs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "visitor_budget_micros" integer DEFAULT 500000 NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_facts" ADD COLUMN "visibility" "fact_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_conversations" ADD CONSTRAINT "visitor_conversations_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visitor_messages" ADD CONSTRAINT "visitor_messages_conversation_id_visitor_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."visitor_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ipersons" ADD CONSTRAINT "ipersons_handle_unique" UNIQUE("handle");