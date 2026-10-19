-- One durable asset-draw task per drawing request, plus the columns that tie
-- every supervisor and worker child run back to its task and frames.
CREATE TABLE "run_tasks" (
  "id" text PRIMARY KEY,
  "thread_id" text NOT NULL REFERENCES "generation_threads"("id") ON DELETE CASCADE,
  "asset_id" text REFERENCES "assets"("id") ON DELETE CASCADE,
  "status" text NOT NULL,
  "phase" text NOT NULL,
  "shape" jsonb,
  "plan" jsonb,
  "usage" jsonb,
  "durable_task_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "task_id" text REFERENCES "run_tasks"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "worker_key" text;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "frame_ids" jsonb;
