CREATE TYPE "public"."connector_category" AS ENUM('shopping', 'travel', 'jobs', 'productivity', 'other');--> statement-breakpoint
CREATE TYPE "public"."connector_type" AS ENUM('mail', 'mcp', 'upload', 'org');--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"type" "connector_type" NOT NULL,
	"category" "connector_category" NOT NULL,
	"icon_url" text,
	"cover_url" text,
	"tagline" text NOT NULL,
	"long_description" text DEFAULT '' NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sender_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"badge" text,
	"verified" boolean DEFAULT false NOT NULL,
	"live" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "user_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"health" text DEFAULT 'ok' NOT NULL,
	"status_line" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_services" ADD CONSTRAINT "user_services_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_services" ADD CONSTRAINT "user_services_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_services_user_connector_idx" ON "user_services" USING btree ("user_id","connector_id");--> statement-breakpoint
-- Seed the first four services (icons are uploaded by the admin; until then a monogram tile shows).
INSERT INTO "connectors" ("slug","name","type","category","tagline","long_description","capabilities","scopes","sender_domains","featured","sort_order","badge","verified") VALUES
('yousoft','Yousoft IT','org','jobs','Jobs and internships that fit your skills','Yousoft IT is a software company hiring developers and interns. When you activate it, Yousoft can propose job offers that match what your twin knows about your skills, and its recruiting assistant can talk to your twin about your public facts. Anything that needs you, like an interview or your CV, always comes to you as an approval card first.','["Talks to your twin about jobs","Proposes matching offers","Asks for interviews only with your OK"]','[{"id":"receive_offers","label":"Receive job offers","description":"Yousoft IT may propose job offers to me","required":true},{"id":"public_profile","label":"Talk to my twin","description":"Yousoft IT''s assistant may talk to my twin about my public facts","required":false},{"id":"requests","label":"Ask me for things","description":"Yousoft IT may ask me for an interview or my CV (I always approve)","required":false}]','[]',true,10,'new',true),
('amazon-de','Amazon.de','mail','shopping','Learn your usual orders, reorder in one tap','Your twin reads only your Amazon.de order and shipping emails (never anything else), learns what you buy and how often, reminds you before you run out, and prepares prefilled checkout links that you approve.','["Learn from your orders","Reorder reminders","Prefilled checkout links"]','[{"id":"read_orders","label":"Read order emails","description":"Read order, shipping and delivery emails from Amazon.de only","required":true},{"id":"suggest","label":"Suggest deals","description":"Suggest cheaper or similar items from Amazon.de","required":false}]','["amazon.de","marketplace.amazon.de"]',true,20,'popular',false),
('booking','Booking.com','mail','travel','Your stays, upcoming trips and better hotels','Your twin reads only your Booking.com confirmation emails, learns where and how you like to stay, reminds you of upcoming check-ins, and finds similar hotels with free cancellation when you plan a trip.','["Learn how you travel","Upcoming check-in reminders","Find similar hotels"]','[{"id":"read_bookings","label":"Read booking emails","description":"Read reservation emails from Booking.com only","required":true},{"id":"suggest","label":"Suggest stays","description":"Suggest similar hotels for your trips","required":false}]','["booking.com"]',false,30,null,false),
('skyscanner','Skyscanner','mail','travel','Your routes and cheaper fares','Your twin reads only flight confirmation emails from Skyscanner and the airlines you choose, learns your usual routes, and tells you when a fare on a route you fly often drops.','["Learn your usual routes","Fare drop alerts","Flight reminders"]','[{"id":"read_flights","label":"Read flight emails","description":"Read flight confirmations from Skyscanner and airlines only","required":true},{"id":"suggest","label":"Suggest fares","description":"Suggest cheaper fares on your routes","required":false}]','["skyscanner.net","skyscanner.de"]',false,40,'beta',false);
