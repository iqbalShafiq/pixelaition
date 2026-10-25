/**
 * One-way migration: native-size frames used to store an artboard scene. They
 * are pixel documents now, so each scene is rasterized into a Background layer
 * and an Artwork layer at the frame's own size. Run once per database:
 *
 *   pnpm --filter @pixelaition/api exec dotenv -e ../../.env -- \
 *     tsx scripts/migrate-native-frames.ts
 */
import {
  assets as assetsTable,
  createDatabase,
  frames as framesTable,
  projects as projectsTable,
} from "@pixelaition/db";
import { and, eq } from "drizzle-orm";
import { getPreset, renderScene, type ArtboardScene } from "@pixelaition/artboard";
import { encodePixels, frameToBuffer, type FrameBuffer } from "@pixelaition/pixel";
import { getAssetRecord } from "../src/store.js";

const db = createDatabase();
const assets = await db
  .select({ id: assetsTable.id, userId: projectsTable.userId })
  .from(assetsTable)
  .innerJoin(projectsTable, eq(assetsTable.projectId, projectsTable.id));

for (const asset of assets) {
  const record = await getAssetRecord(db, asset.userId, asset.id);
  if (!record || !record.frames.some((frame) => frame.kind === "social")) continue;
  const palette = record.palette as string[];
  const sprites = new Map<
    string,
    {
      assetId: string;
      assetName: string;
      frameId: string;
      frameName: string;
      buffer: FrameBuffer;
    }
  >();
  for (const frame of record.frames) {
    if (frame.kind === "social") continue;
    sprites.set(`${record.id}:${frame.id}`, {
      assetId: record.id,
      assetName: record.name,
      frameId: frame.id,
      frameName: frame.name,
      buffer: frameToBuffer(
        frame,
        frame.width ?? record.width,
        frame.height ?? record.height,
        palette,
      ),
    });
  }
  for (const frame of record.frames) {
    if (frame.kind !== "social" || !frame.scene || !frame.presetId) continue;
    const preset = getPreset(frame.presetId);
    const scene = frame.scene as ArtboardScene;
    const background = renderScene({
      scene: { ...scene, elements: [] },
      preset,
      palette,
      sprites,
    }).image;
    const artwork = renderScene({
      scene: { ...scene, background: { kind: "transparent" } },
      preset,
      palette,
      sprites,
    }).image;
    await db
      .update(framesTable)
      .set({
        kind: "sprite",
        layers: [
          {
            id: "background",
            name: "Background",
            visible: true,
            pixels: encodePixels(background.indices),
          },
          {
            id: "artwork",
            name: "Artwork",
            visible: true,
            pixels: encodePixels(artwork.indices),
          },
        ],
        scene: null,
        version: frame.version + 1,
        status: "ready",
        updatedAt: new Date(),
      })
      .where(and(eq(framesTable.id, frame.id), eq(framesTable.assetId, record.id)));
    console.log(`migrated ${record.name} · ${frame.name}`);
  }
}

await db.$client.end();
