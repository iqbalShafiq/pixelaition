-- The catalog names how every model answers: the chat-completions shape or
-- the responses shape. A typo here silently breaks a model's tool calls (as
-- deepseek-v4.1-flash's did), so the column only takes the two it supports.
-- The drop makes this re-runnable: this migration was once applied to a
-- database by hand (the constraint existed before the journal carried it).
ALTER TABLE "models" DROP CONSTRAINT IF EXISTS "models_api_known";--> statement-breakpoint
ALTER TABLE "models" ADD CONSTRAINT "models_api_known" CHECK ("api" IN ('chat', 'responses'));
