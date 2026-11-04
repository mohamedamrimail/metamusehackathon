CREATE TABLE "voice_latency" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"iperson_id" uuid,
	"stt_ms" integer,
	"first_model_ms" integer,
	"reply_ms" integer,
	"tts_ms" integer,
	"total_ms" integer,
	"tts_mode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_latency" ADD CONSTRAINT "voice_latency_iperson_id_ipersons_id_fk" FOREIGN KEY ("iperson_id") REFERENCES "public"."ipersons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_latency_created_idx" ON "voice_latency" USING btree ("created_at");