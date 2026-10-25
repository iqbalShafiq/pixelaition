CREATE TABLE "frame_tags" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"name" text NOT NULL,
	"from_frame_id" text NOT NULL,
	"to_frame_id" text NOT NULL,
	"direction" text DEFAULT 'forward' NOT NULL,
	"loop" boolean DEFAULT true NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "duration_ms" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "frame_tags" ADD CONSTRAINT "frame_tags_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_tags" ADD CONSTRAINT "frame_tags_from_frame_id_frames_id_fk" FOREIGN KEY ("from_frame_id") REFERENCES "public"."frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frame_tags" ADD CONSTRAINT "frame_tags_to_frame_id_frames_id_fk" FOREIGN KEY ("to_frame_id") REFERENCES "public"."frames"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "frame_tags_asset_name" ON "frame_tags" USING btree ("asset_id","name");--> statement-breakpoint
CREATE INDEX "frame_tags_asset" ON "frame_tags" USING btree ("asset_id");