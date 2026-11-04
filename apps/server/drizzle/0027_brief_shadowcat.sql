CREATE TYPE "public"."twin_connection_status" AS ENUM('pending', 'active', 'declined', 'revoked', 'blocked');--> statement-breakpoint
CREATE TABLE "invite_suppressions" (
	"email_hmac" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inviter_id" uuid NOT NULL,
	"contact_id" uuid,
	"channel" text NOT NULL,
	"token" text NOT NULL,
	"email_hmac" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminded_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"rewarded_at" timestamp with time zone,
	"reward_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "plan_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" jsonb NOT NULL,
	"source" text NOT NULL,
	"link" text,
	"removed" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chosen_slot_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"chosen_place_id" uuid,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"creator_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"duration_min" integer NOT NULL,
	"date_from" text NOT NULL,
	"date_to" text NOT NULL,
	"time_of_day" text DEFAULT 'any' NOT NULL,
	"area" text,
	"budget" text,
	"note" text,
	"auto_confirm" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"counter_used" boolean DEFAULT false NOT NULL,
	"booked_start" timestamp with time zone,
	"booked_end" timestamp with time zone,
	"booked_place_id" uuid,
	"end_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "twin_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"status" "twin_connection_status" DEFAULT 'pending' NOT NULL,
	"requester_scopes" jsonb DEFAULT '["plan"]'::jsonb NOT NULL,
	"recipient_scopes" jsonb DEFAULT '["plan"]'::jsonb NOT NULL,
	"requester_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recipient_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_by" uuid,
	"origin" text DEFAULT 'contacts' NOT NULL,
	"action_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identifiers" (
	"kind" text NOT NULL,
	"hmac" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "has_iperson" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "matched_user_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "invite_status" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discoverability" text DEFAULT 'contacts' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_accepted_user_id_users_id_fk" FOREIGN KEY ("accepted_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_options" ADD CONSTRAINT "plan_options_session_id_plan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_participants" ADD CONSTRAINT "plan_participants_session_id_plan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."plan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_participants" ADD CONSTRAINT "plan_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_sessions" ADD CONSTRAINT "plan_sessions_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twin_connections" ADD CONSTRAINT "twin_connections_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "twin_connections" ADD CONSTRAINT "twin_connections_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identifiers" ADD CONSTRAINT "user_identifiers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invites_inviter_idx" ON "invites" USING btree ("inviter_id","sent_at");--> statement-breakpoint
CREATE INDEX "invites_contact_idx" ON "invites" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "plan_options_session_idx" ON "plan_options" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_participants_uq" ON "plan_participants" USING btree ("session_id","user_id");--> statement-breakpoint
CREATE INDEX "plan_participants_user_idx" ON "plan_participants" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "plan_sessions_creator_idx" ON "plan_sessions" USING btree ("creator_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "twin_connections_pair_uq" ON "twin_connections" USING btree ("requester_id","recipient_id");--> statement-breakpoint
CREATE INDEX "twin_connections_recipient_idx" ON "twin_connections" USING btree ("recipient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_identifiers_pk" ON "user_identifiers" USING btree ("kind","hmac");--> statement-breakpoint
CREATE INDEX "user_identifiers_user_idx" ON "user_identifiers" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_matched_user_id_users_id_fk" FOREIGN KEY ("matched_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;