UPDATE "models" SET "id" = 'meta/muse-spark-1.3-contributor', "api" = 'responses', "efforts" = '["low","medium","high"]'::jsonb, "vision" = true WHERE "id" = 'muse-spark-1.3-contributor';--> statement-breakpoint
UPDATE "models" SET "id" = 'deepseek/deepseek-v4.1-flash', "api" = 'chat', "efforts" = '["low","medium","high"]'::jsonb, "vision" = false WHERE "id" = 'deepseek-v4.1-flash';
