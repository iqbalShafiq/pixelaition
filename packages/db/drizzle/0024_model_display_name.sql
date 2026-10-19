-- A model's user-facing name is not its provider slug: the composer, the
-- console header, and a turn's meta print the display name, while the slug
-- stays the value sent to the provider. Every catalog row must carry one.
ALTER TABLE "models" ADD COLUMN "display_name" text;--> statement-breakpoint
UPDATE "models" SET "display_name" = 'Deepseek v4.1 Flash 1017' WHERE "id" = 'deepseek/deepseek-v4.1-flash-1017';--> statement-breakpoint
UPDATE "models" SET "display_name" = 'Muse Spark 1.3 Contributor' WHERE "id" = 'meta/muse-spark-1.3-contributor';--> statement-breakpoint
UPDATE "models" SET "display_name" = "id" WHERE "display_name" IS NULL;--> statement-breakpoint
ALTER TABLE "models" ALTER COLUMN "display_name" SET NOT NULL;
