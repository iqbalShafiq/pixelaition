ALTER TABLE "frames" ADD COLUMN "groups" jsonb DEFAULT '[]'::jsonb NOT NULL;
