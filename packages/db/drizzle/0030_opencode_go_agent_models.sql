-- The main drawing agent moves from OpenRouter to OpenCode Go. Go serves
-- DeepSeek V4.1 Flash over OpenAI Chat Completions and Muse Spark 1.3
-- Contributor over the OpenAI Responses API, both under
-- https://opencode.ai/inference/go/v1.
INSERT INTO "models" ("id", "display_name", "api", "efforts", "position", "enabled", "vision", "user_images", "roles", "context_window")
VALUES (
  'deepseek-v4.1-flash',
  'DeepSeek V4.1 Flash',
  'chat',
  '["low","high","max"]'::jsonb,
  0,
  true,
  false,
  true,
  '["summary-text"]'::jsonb,
  1000000
)
ON CONFLICT ("id") DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "api" = EXCLUDED."api",
  "efforts" = EXCLUDED."efforts",
  "position" = EXCLUDED."position",
  "enabled" = EXCLUDED."enabled",
  "vision" = EXCLUDED."vision",
  "user_images" = EXCLUDED."user_images",
  "roles" = EXCLUDED."roles",
  "context_window" = EXCLUDED."context_window",
  "updated_at" = now();
--> statement-breakpoint
INSERT INTO "models" ("id", "display_name", "api", "efforts", "position", "enabled", "vision", "user_images", "roles", "context_window")
VALUES (
  'muse-spark-1.3-contributor',
  'Muse Spark 1.3 Contributor',
  'responses',
  '["minimal","low","medium","high","xhigh"]'::jsonb,
  1,
  true,
  true,
  true,
  '["summary-vision"]'::jsonb,
  1000000
)
ON CONFLICT ("id") DO UPDATE SET
  "display_name" = EXCLUDED."display_name",
  "api" = EXCLUDED."api",
  "efforts" = EXCLUDED."efforts",
  "position" = EXCLUDED."position",
  "enabled" = EXCLUDED."enabled",
  "vision" = EXCLUDED."vision",
  "user_images" = EXCLUDED."user_images",
  "roles" = EXCLUDED."roles",
  "context_window" = EXCLUDED."context_window",
  "updated_at" = now();
--> statement-breakpoint
UPDATE "user_preferences"
SET "last_model_id" = CASE "last_model_id"
  WHEN 'deepseek/deepseek-v4.1-flash-1017' THEN 'deepseek-v4.1-flash'
  WHEN 'meta/muse-spark-1.3-contributor' THEN 'muse-spark-1.3-contributor'
  ELSE "last_model_id"
END
WHERE "last_model_id" IN (
  'deepseek/deepseek-v4.1-flash-1017',
  'meta/muse-spark-1.3-contributor'
);
--> statement-breakpoint
DELETE FROM "models"
WHERE "id" IN (
  'deepseek/deepseek-v4.1-flash-1017',
  'meta/muse-spark-1.3-contributor'
);
