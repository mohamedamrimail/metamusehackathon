CREATE TYPE "public"."rule_kind" AS ENUM('do', 'dont');--> statement-breakpoint
CREATE TYPE "public"."rule_source" AS ENUM('user', 'onboarding', 'chat', 'learned', 'system');--> statement-breakpoint
ALTER TYPE "public"."fact_source" ADD VALUE 'link';--> statement-breakpoint
CREATE TABLE "iperson_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"kind" "rule_kind" NOT NULL,
	"text" text NOT NULL,
	"source" "rule_source" DEFAULT 'user' NOT NULL,
	"source_note" text,
	"active" boolean DEFAULT true NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"summary" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_prefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"rank" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "setup_step" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "iperson_rules" ADD CONSTRAINT "iperson_rules_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_links" ADD CONSTRAINT "profile_links_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_prefs" ADD CONSTRAINT "source_prefs_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "iperson_rules_iperson_idx" ON "iperson_rules" USING btree ("iperson_id");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_links_uq" ON "profile_links" USING btree ("iperson_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "source_prefs_uq" ON "source_prefs" USING btree ("iperson_id","provider");