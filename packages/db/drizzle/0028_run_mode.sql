ALTER TABLE "generation_runs" ADD COLUMN IF NOT EXISTS "mode" text NOT NULL DEFAULT 'draw';
UPDATE "generation_runs" SET "mode" = 'compose' WHERE "set_id" IS NOT NULL;
