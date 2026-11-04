CREATE TYPE "public"."age_range" AS ENUM('18-24', '25-34', '35-44', '45-54', '55-64', '65+');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('woman', 'man', 'unspecified');--> statement-breakpoint
CREATE TABLE "avatar_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid,
	"library" boolean DEFAULT false NOT NULL,
	"look_id" uuid,
	"style" text NOT NULL,
	"variant" text DEFAULT 'base' NOT NULL,
	"gender" "gender",
	"age_range" "age_range",
	"image_url" text NOT NULL,
	"masks" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ipersons" ADD COLUMN "avatar_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "gender" "gender";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_range" "age_range";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_version" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "avatar_assets" ADD CONSTRAINT "avatar_assets_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "avatar_assets_look_idx" ON "avatar_assets" USING btree ("look_id");--> statement-breakpoint
CREATE INDEX "avatar_assets_library_idx" ON "avatar_assets" USING btree ("library","gender","age_range");