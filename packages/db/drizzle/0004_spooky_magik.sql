ALTER TABLE "models" ADD COLUMN "vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "models" SET "vision" = true WHERE "id" = 'muse-spark-1.3-contributor';
