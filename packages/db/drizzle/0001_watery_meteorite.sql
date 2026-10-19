CREATE TABLE "models" (
	"id" text PRIMARY KEY NOT NULL,
	"api" text NOT NULL,
	"efforts" jsonb NOT NULL,
	"position" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
INSERT INTO "models" ("id", "api", "efforts", "position") VALUES
  ('deepseek-v4.1-flash', 'chat', '["low","high","max"]'::jsonb, 0),
  ('muse-spark-1.3-contributor', 'responses', '["minimal","low","medium","high","xhigh"]'::jsonb, 1);
