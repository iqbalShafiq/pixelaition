-- OpenCode Go charges every request's output budget against an output-token
-- rate limit, so a request without max_output_tokens is billed the model
-- maximum and trips a 429 after a few calls. The catalog now keeps a
-- per-model output budget and the worker sends it with every request.
ALTER TABLE "models" ADD COLUMN "max_output_tokens" integer DEFAULT 8192 NOT NULL;
