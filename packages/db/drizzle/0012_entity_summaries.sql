ALTER TABLE "projects" ADD COLUMN "summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "summary" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "summary_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE "run_proposals" (
  "id" text PRIMARY KEY,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "prompt" text NOT NULL,
  "intent" text NOT NULL,
  "project_id" text,
  "asset_id" text,
  "project_confidence" real,
  "asset_confidence" real,
  "guardrail" jsonb,
  "decision" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone
);
