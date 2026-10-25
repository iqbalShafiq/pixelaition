-- One asset can hold sprite frames and social frames at native sizes. A social
-- frame keeps its scene; sprite frames keep their layers. The old artboard rows
-- become social frames here so an existing kit stays visible in the editor.
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "copy" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'sprite';
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "width" integer;
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "height" integer;
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "preset_id" text;
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "scene" jsonb;
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "copy_override" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'ready';
ALTER TABLE "frames" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1;

UPDATE "frames" f
SET "width" = a."width", "height" = a."height"
FROM "assets" a
WHERE f."asset_id" = a."id" AND (f."width" IS NULL OR f."height" IS NULL);

WITH bounds AS (
  SELECT "asset_id", MAX("index") AS "max_index"
  FROM "frames"
  GROUP BY "asset_id"
),
migrated AS (
  SELECT
    ab.*,
    s."asset_id",
    ROW_NUMBER() OVER (PARTITION BY s."asset_id" ORDER BY ab."created_at", ab."id") AS rn
  FROM "artboards" ab
  JOIN "artboard_sets" s ON s."id" = ab."set_id"
)
INSERT INTO "frames" (
  "id", "asset_id", "name", "index", "layers",
  "kind", "width", "height", "preset_id", "scene",
  "copy_override", "status", "version", "created_at", "updated_at"
)
SELECT
  m."id", m."asset_id", m."name",
  (COALESCE(b."max_index", -1) + m.rn)::integer,
  '[]'::jsonb,
  'social', m."width", m."height", m."preset_id", m."scene",
  m."copy_override", m."status", m."version", m."created_at", m."updated_at"
FROM migrated m
LEFT JOIN bounds b ON b."asset_id" = m."asset_id"
ON CONFLICT ("id") DO NOTHING;

UPDATE "assets" a
SET "copy" = latest."copy"
FROM (
  SELECT DISTINCT ON ("asset_id") "asset_id", "copy"
  FROM "artboard_sets"
  ORDER BY "asset_id", "updated_at" DESC
) latest
WHERE latest."asset_id" = a."id" AND a."copy" = '{}'::jsonb;

CREATE INDEX IF NOT EXISTS "frames_asset_kind" ON "frames" ("asset_id", "kind", "index");
