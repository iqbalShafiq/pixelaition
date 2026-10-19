-- The agent provider moves to OpenRouter, whose model ids are the provider's
-- own slugs. This migration is the catalog's whole seed: the two rows below
-- are written in full, so a fresh database and an existing one agree on every
-- column. The delete after them retires every model this seed no longer lists,
-- which keeps the composer from offering a model the provider does not serve.
INSERT INTO "models" ("id", "api", "efforts", "position", "enabled", "vision", "user_images", "roles", "context_window")
VALUES
  ('deepseek/deepseek-v4.1-flash-1017', 'chat', '["low","high","max"]'::jsonb, 0, true, false, true, '["summary-text"]'::jsonb, 1048576),
  ('meta/muse-spark-1.3-contributor', 'responses', '["minimal","low","medium","high","xhigh"]'::jsonb, 1, true, true, true, '["summary-vision"]'::jsonb, 1048576)
ON CONFLICT ("id") DO UPDATE SET
  "api" = EXCLUDED."api",
  "efforts" = EXCLUDED."efforts",
  "position" = EXCLUDED."position",
  "enabled" = EXCLUDED."enabled",
  "vision" = EXCLUDED."vision",
  "user_images" = EXCLUDED."user_images",
  "roles" = EXCLUDED."roles",
  "context_window" = EXCLUDED."context_window",
  "updated_at" = now();--> statement-breakpoint
DELETE FROM "models"
WHERE "id" NOT IN (
  'deepseek/deepseek-v4.1-flash-1017',
  'meta/muse-spark-1.3-contributor'
);
