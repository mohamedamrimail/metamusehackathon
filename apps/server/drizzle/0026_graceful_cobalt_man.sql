CREATE TABLE "time_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"minutes" real NOT NULL,
	"justification" text NOT NULL,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "weekly_summary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "time_estimates_kind_idx" ON "time_estimates" USING btree ("kind","valid_from");--> statement-breakpoint
-- Defaults (Impact §1): conservative minutes per completed, approved action. Valid from the start of time.
INSERT INTO "time_estimates" ("kind", "minutes", "justification", "valid_from") VALUES
  ('calendar', 2, 'Open calendar, find slot, create event', '2026-01-01'),
  ('email', 3, 'Write, address and send a short email', '2026-01-01'),
  ('travel_handoff', 10, 'Search, filter and compare on the site', '2026-01-01'),
  ('reorder_handoff', 3, 'Find the past item and reorder', '2026-01-01'),
  ('opportunity', 10, 'Searching for a class, deal or event', '2026-01-01'),
  ('twin_plan', 8, 'Back-and-forth messages to agree on time and place', '2026-01-01'),
  ('partner_request', 10, 'Email exchange with a recruiter or business', '2026-01-01'),
  ('visitor_message', 2, 'Replying to a simple message', '2026-01-01');
