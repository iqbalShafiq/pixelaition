-- MiniMax retired the free launch variant on 2026-10-22. Keeping the row
-- offered a model the provider answers with 404; every new run failed before
-- the plan could start. The paid slug is still available, but this catalog's
-- default is the already-configured DeepSeek model, so existing preferences
-- move there instead of silently switching to a paid endpoint.
DELETE FROM "models"
WHERE "id" = 'minimax/minimax-m3.1-flash:free';
--> statement-breakpoint
UPDATE "user_preferences"
SET "last_model_id" = 'deepseek/deepseek-v4.1-flash-1017'
WHERE "last_model_id" = 'minimax/minimax-m3.1-flash:free';
