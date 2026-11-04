ALTER TABLE "users" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "welcomed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "selfie_consent_at" timestamp with time zone;--> statement-breakpoint
-- Numbers linked before verification existed count as verified (Phase 2.6).
UPDATE "users" SET "verified_at" = now(), "welcomed_at" = now() WHERE "phone_e164" IS NOT NULL;
