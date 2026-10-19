-- One context window per model, seeded by migrations. The worker feeds this to
-- Anvia's completion model as `contextLimits`, which is what makes the adapter
-- attach `contextUsage` (used/remaining tokens and percent against the window)
-- to every response. Both catalog models declare one million tokens: Muse Spark
-- 1.3 Contributor's card and DeepSeek V4.1-Flash's release material both state
-- 1,048,576. A null window means "not declared": the console shows no context
-- line instead of guessing.
ALTER TABLE "models" ADD COLUMN "context_window" integer;--> statement-breakpoint
UPDATE "models" SET "context_window" = 1048576 WHERE "id" IN ('deepseek-v4.1-flash', 'muse-spark-1.3-contributor');
