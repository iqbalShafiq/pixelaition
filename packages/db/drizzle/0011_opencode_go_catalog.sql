-- The agent provider moved back to OpenCode Go: model ids are unprefixed, and
-- the catalog keeps the reasoning efforts that endpoint accepts.
UPDATE "models" SET "id" = 'muse-spark-1.3-contributor', "api" = 'responses', "efforts" = '["minimal","low","medium","high","xhigh"]'::jsonb, "vision" = true WHERE "id" = 'meta/muse-spark-1.3-contributor';--> statement-breakpoint
UPDATE "models" SET "id" = 'deepseek-v4.1-flash', "api" = 'chat', "efforts" = '["low","high","max"]'::jsonb, "vision" = false WHERE "id" = 'deepseek/deepseek-v4.1-flash';
