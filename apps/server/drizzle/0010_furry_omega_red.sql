CREATE TABLE "org_pipeline" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partner_slug" text NOT NULL,
	"offer_id" uuid NOT NULL,
	"twin_id" text NOT NULL,
	"stage" text NOT NULL,
	"request_id" uuid,
	"conversation_id" uuid,
	"detail" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "org_pipeline_idx" ON "org_pipeline" USING btree ("partner_slug","offer_id","twin_id");