-- The output budget goes away: summaries are guided by their prompt (the
-- alt-text convention, one or two sentences), and no call declares
-- max_output_tokens. The column and its values are dropped with it.
ALTER TABLE "models" DROP COLUMN "max_output_tokens";
