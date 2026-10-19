-- Jobs belong to the catalog, not to whichever row came first. Summary model
-- selection used to pick the first vision- or chat-capable row by position,
-- which a test fixture could win; a role is an explicit assignment.
ALTER TABLE "models" ADD COLUMN "roles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "models" SET "roles" = '["summary-text"]'::jsonb WHERE "id" = 'deepseek-v4.1-flash';--> statement-breakpoint
UPDATE "models" SET "roles" = '["summary-vision"]'::jsonb WHERE "id" = 'muse-spark-1.3-contributor';
