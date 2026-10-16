-- The DeepSeek Vision guide states the current Flash model (V4.1-Flash, the
-- official `deepseek-flash`) reads images in user messages; a live probe
-- through the agent gateway described a rendered frame correctly. The `vision`
-- column guards tool-result images (a `view_image` preview), which the pinned
-- chat adapter flattens to `[file:image/png]` text, so a chat-shape model
-- keeps `vision = false`. This column is the user-attachment capability:
-- composer references and earlier turns' reference images, which the chat
-- adapter delivers as `image_url` parts.
ALTER TABLE "models" ADD COLUMN "user_images" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "models" SET "user_images" = true WHERE "id" IN ('deepseek-v4.1-flash', 'muse-spark-1.3-contributor');
