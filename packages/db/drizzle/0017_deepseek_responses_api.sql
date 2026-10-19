-- deepseek-v4.1-flash streams tool calls through the Responses shape: the
-- chat adapter ended its streams mid tool call ("invalid tool call" / "stream
-- ended before its tool call was complete"). The same model on the responses
-- path painted a full plan in testing.
UPDATE "models" SET "api" = 'responses' WHERE "id" = 'deepseek-v4.1-flash';
