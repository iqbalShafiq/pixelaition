CREATE TABLE "artboard_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"name" text NOT NULL,
	"copy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artboards" (
	"id" text PRIMARY KEY NOT NULL,
	"set_id" text NOT NULL,
	"preset_id" text NOT NULL,
	"name" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"pixel_unit" integer NOT NULL,
	"scene" jsonb NOT NULL,
	"copy_override" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "artboard_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"set_id" text NOT NULL,
	"artboard_id" text,
	"scope" text NOT NULL,
	"kind" text NOT NULL,
	"author" text NOT NULL,
	"run_id" text,
	"label" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_tasks" ADD COLUMN "set_id" text;
--> statement-breakpoint
ALTER TABLE "generation_runs" ADD COLUMN "set_id" text;
--> statement-breakpoint
ALTER TABLE "artboard_sets" ADD CONSTRAINT "artboard_sets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artboard_sets" ADD CONSTRAINT "artboard_sets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artboards" ADD CONSTRAINT "artboards_set_id_artboard_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."artboard_sets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artboard_versions" ADD CONSTRAINT "artboard_versions_set_id_artboard_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."artboard_sets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "artboard_versions" ADD CONSTRAINT "artboard_versions_artboard_id_artboards_id_fk" FOREIGN KEY ("artboard_id") REFERENCES "public"."artboards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "run_tasks" ADD CONSTRAINT "run_tasks_set_id_artboard_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."artboard_sets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_set_id_artboard_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."artboard_sets"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "artboards_set_created" ON "artboards" USING btree ("set_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "artboard_versions_set_created" ON "artboard_versions" USING btree ("set_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);
