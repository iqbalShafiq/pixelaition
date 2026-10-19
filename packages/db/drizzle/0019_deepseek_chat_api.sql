-- Deepseek's thinking mode is only honoured on the chat-completions shape:
-- on the responses shape every tool-loop turn came back with
--   "400 The `reasoning_text` in the thinking mode must be passed back to the API."
-- while the chat path produced full plans and painting with only transient
-- gateway errors. The catalog keeps both shapes; this model's is chat.
UPDATE "models" SET "api" = 'chat' WHERE "id" = 'deepseek-v4.1-flash';
