ALTER TABLE "contacts" ADD COLUMN "learned_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Jury §4 data minimisation: notes never keep quoted email text and are at most 100 characters.
UPDATE "contacts" SET "notes" = NULL WHERE "notes" ~ '["“”«»„]';--> statement-breakpoint
UPDATE "contacts" SET "notes" = left("notes", 99) || '…' WHERE length("notes") > 100;--> statement-breakpoint
-- Contacts / calendar import became separate opt-ins: mailboxes that already granted them keep importing.
UPDATE "connections" SET "config" = "config" || '{"importContacts":true}'::jsonb WHERE "kind"::text IN ('mail_microsoft', 'mail_google') AND "config"->>'scopes' ~* 'contacts\.read';--> statement-breakpoint
UPDATE "connections" SET "config" = "config" || '{"importCalendar":true}'::jsonb WHERE "kind"::text IN ('mail_microsoft', 'mail_google') AND "config"->>'scopes' ~* 'calendars?\.read';
