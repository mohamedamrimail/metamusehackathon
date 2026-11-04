CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"emails" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phones" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"birthday" text,
	"relationship" text,
	"label" text,
	"notes" text,
	"in_address_book" boolean DEFAULT false NOT NULL,
	"mails_from" integer DEFAULT 0 NOT NULL,
	"mails_to" integer DEFAULT 0 NOT NULL,
	"last_contact_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "source" text DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_key_uq" ON "contacts" USING btree ("user_id","key");--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_external_uq" ON "calendar_events" USING btree ("iperson_id","external_id");