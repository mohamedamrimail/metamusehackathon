ALTER TYPE "public"."connection_kind" ADD VALUE 'mail_microsoft';--> statement-breakpoint
ALTER TYPE "public"."connection_kind" ADD VALUE 'mail_google';--> statement-breakpoint
ALTER TYPE "public"."fact_source" ADD VALUE 'mailbox';--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_id" uuid,
	"connection_id" uuid,
	"provider_ref" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"city" text,
	"country" text,
	"route_from" text,
	"route_to" text,
	"stars" real,
	"nights" integer,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"free_cancellation" boolean,
	"amount_cents" bigint,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"valid_until" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_seen" (
	"connection_id" uuid NOT NULL,
	"hash" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_id" uuid,
	"connection_id" uuid,
	"provider_ref" text NOT NULL,
	"merchant" text NOT NULL,
	"title" text NOT NULL,
	"item_ref" text,
	"category" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"amount_cents" bigint,
	"currency" text,
	"ordered_at" timestamp with time zone NOT NULL,
	"delivery_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_seen" ADD CONSTRAINT "mail_seen_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_user_ref_idx" ON "bookings" USING btree ("user_id","provider_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_user_key_idx" ON "insights" USING btree ("user_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_seen_idx" ON "mail_seen" USING btree ("connection_id","hash");--> statement-breakpoint
CREATE UNIQUE INDEX "purchases_user_ref_idx" ON "purchases" USING btree ("user_id","provider_ref","title");