-- The seed renamed the two catalog models to their provider slugs, but every
-- run already recorded the old, unprefixed id. They are the same models, so
-- the rename is carried into the history too: a run can then join its catalog
-- row, and the console names the last model with its real window before the
-- first context snapshot exists.
UPDATE "generation_runs" SET "model_id" = 'deepseek/deepseek-v4.1-flash-1017' WHERE "model_id" = 'deepseek-v4.1-flash';--> statement-breakpoint
UPDATE "generation_runs" SET "model_id" = 'meta/muse-spark-1.3-contributor' WHERE "model_id" = 'muse-spark-1.3-contributor';
