import { randomUUID } from "node:crypto";
import type { FrameChange, Stroke } from "@pixelaition/agent";
import {
  assets,
  createDatabase,
  frames,
  projects,
  user,
  versions,
  type Database,
} from "@pixelaition/db";
import { bufferToFrame, createBuffer } from "@pixelaition/pixel";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { frameWrites } from "./frame-writes.js";

/**
 * The frame-write callbacks own what lands in the database mid-run. The canvas
 * resize once updated the frames but never the asset row, so a reload decoded
 * 48×48 pixels against a 32×32 asset. Needs a live database; skips without one.
 */
async function probe(url: string | undefined): Promise<Database | undefined> {
  if (!url) return undefined;
  const candidate = createDatabase(url);
  try {
    await Promise.race([
      candidate.execute(sql`select 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("database probe timed out")), 3000),
      ),
    ]);
    return candidate;
  } catch {
    await candidate.$client.end({ timeout: 1 }).catch(() => undefined);
    return undefined;
  }
}

const db = await probe(process.env.DATABASE_URL);

const palette = ["#00000000", "#1a1c2c", "#f4efe4"];

async function waitFor(check: () => Promise<boolean>, tries = 40): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition never became true");
}

describe.skipIf(!db)("frame writes", () => {
  const userId = randomUUID();
  const projectId = randomUUID();
  const assetId = randomUUID();
  const frameId = randomUUID();
  const runId = randomUUID();
  let live: Database;
  let writes: ReturnType<typeof frameWrites>;
  const published: Array<{ type: string; data: Record<string, unknown> }> = [];

  beforeAll(async () => {
    if (!db) throw new Error("database probe did not resolve");
    live = db;
    await live.insert(user).values({
      id: userId,
      name: "Frame Writes Test",
      email: `frame-writes-${userId}@test.local`,
    });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "svt",
      description: "",
      style: {
        notes: "",
        outline: "#1a1c2c",
        defaultWidth: 32,
        defaultHeight: 32,
        shadowDirection: "down",
      },
    });
    await live.insert(assets).values({
      id: assetId,
      projectId,
      name: "scoups",
      width: 32,
      height: 32,
      palette,
    });
    const initial = createBuffer({
      width: 32,
      height: 32,
      palette,
      layerName: "head",
    });
    await live.insert(frames).values({
      id: frameId,
      assetId,
      name: "sweet-face",
      index: 0,
      layers: bufferToFrame(initial, { id: frameId, name: "sweet-face", index: 0 })
        .layers,
    });
    writes = frameWrites(
      {
        durableRunId: randomUUID(),
        publicRunId: runId,
        assetId,
        frames: [{ id: frameId, name: "sweet-face", index: 0 }],
      },
      {
        db: live,
        publish: (_runId, type, data) => {
          published.push({ type, data: data as Record<string, unknown> });
        },
        loadAsset: async (id) => {
          const [row] = await live.select().from(assets).where(eq(assets.id, id));
          if (!row) return undefined;
          const frameRows = await live
            .select({ id: frames.id })
            .from(frames)
            .where(eq(frames.assetId, id));
          return {
            name: row.name,
            width: row.width,
            height: row.height,
            palette: row.palette as string[],
            frames: frameRows,
          };
        },
      },
    );
  });

  afterAll(async () => {
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  it("persists a canvas resize on the asset row and records its version", async () => {
    await writes.onFrameChange({ type: "resize", width: 48, height: 48 } as FrameChange);
    const [asset] = await live
      .select({ width: assets.width, height: assets.height })
      .from(assets)
      .where(eq(assets.id, assetId));
    expect(asset).toEqual({ width: 48, height: 48 });
    const [version] = await live
      .select({
        kind: versions.kind,
        scope: versions.scope,
        runId: versions.runId,
        snapshot: versions.snapshot,
      })
      .from(versions)
      .where(eq(versions.assetId, assetId))
      .orderBy(desc(versions.createdAt))
      .limit(1);
    expect(version).toMatchObject({
      kind: "resize",
      scope: "asset",
      runId,
      snapshot: { name: "scoups", width: 48, height: 48, frameIds: [frameId] },
    });
  });

  it("carries the buffer's size on every stroke it publishes", async () => {
    const bigger = createBuffer({
      width: 48,
      height: 48,
      palette,
      layerName: "head",
    });
    writes.onStroke({ label: "resize", points: [] } as Stroke, bigger, frameId);
    const stroke = published.filter((item) => item.type === "canvas-stroke").at(-1);
    expect(stroke?.data).toMatchObject({ frameId, width: 48, height: 48 });
    const layers = stroke?.data.layers as Array<{ pixels: string }> | undefined;
    expect(Buffer.from(layers?.[0]?.pixels ?? "", "base64").length).toBe(2304);
    // The frame row follows on the async persist.
    await waitFor(async () => {
      const [row] = await live
        .select({ layers: frames.layers })
        .from(frames)
        .where(eq(frames.id, frameId));
      const encoded = (row?.layers as Array<{ pixels: string }> | undefined)?.[0]?.pixels;
      return Buffer.from(encoded ?? "", "base64").length === 2304;
    });
  });
});
