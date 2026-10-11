ALTER TABLE "generation_threads" ALTER COLUMN "asset_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_threads" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "generation_threads" ADD CONSTRAINT "generation_threads_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_threads" ADD CONSTRAINT "generation_threads_scope" CHECK ("generation_threads"."asset_id" IS NOT NULL OR "generation_threads"."project_id" IS NOT NULL);