ALTER TABLE "partners" ADD COLUMN "operator_affiliated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "partners" SET "operator_affiliated" = true WHERE "slug" = 'yousoft';
