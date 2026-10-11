import { randomUUID } from "node:crypto";
import {
  assets,
  createDatabase,
  frames,
  generationRuns,
  generationThreads,
  projects,
  user,
  versions,
  type Database,
} from "@pixelaition/db";
import { createAsset, defaultStyle, encodePixels } from "@pixelaition/pixel";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVersion, restoreVersion } from "./store.js";

/**
 * restoreVersion needs a live database; when DATABASE_URL is absent or the
 * database cannot be reached (CI without a db service), the suite skips
 * instead of failing.
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

describe.skipIf(!db)("restoreVersion", () => {
  const userId = randomUUID();
  const projectId = randomUUID();
  const asset = createAsset({ name: "restore-test", width: 8, height: 8 });
  const frame = asset.frames[0];
  if (!frame) throw new Error("createAsset produced no frame");
  let live: Database;

  beforeAll(async () => {
    if (!db) throw new Error("database probe did not resolve");
    live = db;
    await live.insert(user).values({
      id: userId,
      name: "Restore Test",
      email: `restore-${userId}@test.local`,
    });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "restore",
      style: defaultStyle,
    });
    await live.insert(assets).values({
      id: asset.id,
      projectId,
      name: asset.name,
      width: asset.width,
      height: asset.height,
      palette: asset.palette,
    });
    await live.insert(frames).values({
      id: frame.id,
      assetId: asset.id,
      name: frame.name,
      index: frame.index,
      layers: frame.layers,
    });
  });

  afterAll(async () => {
    if (!live) return;
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  it("replays the snapshot and records a restore version", async () => {
    const painted = new Uint8Array(asset.width * asset.height);
    painted[9] = 1;
    const layers = frame.layers.map((layer) => ({
      ...layer,
      pixels: encodePixels(painted),
    }));
    const source = await createVersion(live, {
      assetId: asset.id,
      frameId: frame.id,
      scope: "frame",
      kind: "edit",
      author: "user",
      snapshot: { layers },
    });
    if (!source) throw new Error("createVersion inserted nothing");

    const result = await restoreVersion(live, userId, asset.id, source.id);
    expect(result.failure).toBeUndefined();
    const restoredFrame = result.asset?.frames.find((item) => item.id === frame.id);
    expect(restoredFrame?.layers).toEqual(layers);

    const [restoreRow] = await live
      .select()
      .from(versions)
      .where(and(eq(versions.assetId, asset.id), eq(versions.kind, "restore")));
    expect(restoreRow).toBeDefined();
    expect(restoreRow?.label).toContain(source.id);
    expect(restoreRow?.scope).toBe("frame");
    expect(restoreRow?.frameId).toBe(frame.id);
    expect(restoreRow?.author).toBe("user");
    expect(restoreRow?.snapshot).toEqual({ layers });
  });

  it("restores asset metadata from an asset snapshot", async () => {
    const source = await createVersion(live, {
      assetId: asset.id,
      scope: "asset",
      kind: "rename",
      author: "user",
      snapshot: {
        name: "restored-name",
        width: asset.width,
        height: asset.height,
        palette: asset.palette,
        frameIds: [frame.id],
      },
    });
    if (!source) throw new Error("createVersion inserted nothing");

    const result = await restoreVersion(live, userId, asset.id, source.id);
    expect(result.failure).toBeUndefined();
    expect(result.asset?.name).toBe("restored-name");

    const [restoreRow] = await live
      .select()
      .from(versions)
      .where(
        and(
          eq(versions.assetId, asset.id),
          eq(versions.kind, "restore"),
          eq(versions.scope, "asset"),
        ),
      );
    expect(restoreRow?.snapshot).toMatchObject({ name: "restored-name" });
  });

  it("refuses while a run is active for the asset", async () => {
    const threadId = randomUUID();
    const runId = randomUUID();
    await live.insert(generationThreads).values({
      id: threadId,
      assetId: asset.id,
      userId,
    });
    await live.insert(generationRuns).values({
      id: runId,
      threadId,
      requestId: randomUUID(),
      status: "running",
      modelId: "test-model",
      reasoningEffort: "low",
    });
    const [version] = await live
      .select()
      .from(versions)
      .where(and(eq(versions.assetId, asset.id), eq(versions.kind, "edit")));
    if (!version) throw new Error("the edit version was not found");

    const result = await restoreVersion(live, userId, asset.id, version.id);
    expect(result.asset).toBeUndefined();
    expect(result.failure?.code).toBe("RUN_IN_PROGRESS");
    expect(result.failure?.message).toBe("The agent is drawing on this asset right now.");

    await live.delete(generationRuns).where(eq(generationRuns.id, runId));
    await live.delete(generationThreads).where(eq(generationThreads.id, threadId));
  });
});
