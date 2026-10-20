-- The free MiniMax endpoint is the development/evaluation target. It is a
-- chat-shape model: user images ride as image_url, tool-result images do not,
-- so it is not offered as a drawing reviewer. 1M context, reasoning efforts
-- low/medium/high/xhigh/max (OpenRouter model metadata, checked 2026-10-20).
INSERT INTO "models" ("id", "display_name", "api", "efforts", "position", "enabled", "vision", "user_images", "roles", "context_window")
VALUES (
  'minimax/minimax-m3.1-flash:free',
  'MiniMax M3.1 Flash (free)',
  'chat',
  '["low","medium","high","xhigh","max"]'::jsonb,
  2,
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
