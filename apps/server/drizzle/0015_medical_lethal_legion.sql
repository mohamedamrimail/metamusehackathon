ALTER TABLE "connectors" ADD COLUMN "mcp_url" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "mcp_auth_enc" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "tool_allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL;