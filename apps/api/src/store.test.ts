import { randomUUID } from "node:crypto";
import {
  assets,
  createDatabase,
  createVersion,
  frames,
  generationRuns,
  generationThreads,
  projects,
  runTasks,
  user,
  versions,
  type Database,
} from "@pixelaition/db";
import { createAsset, defaultStyle, encodePixels } from "@pixelaition/pixel";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureThread,
  restoreVersion,
  assetHasActiveRun,
  sessionUsageForThread,
} from "./store.js";

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
      snapshot: { name: "restored-idle", layers },
    });
    if (!source) throw new Error("createVersion inserted nothing");

    const result = await restoreVersion(live, userId, asset.id, source.id);
    expect(result.failure).toBeUndefined();
    const restoredFrame = result.asset?.frames.find((item) => item.id === frame.id);
    expect(restoredFrame?.layers).toEqual(layers);
    expect(restoredFrame?.name).toBe("restored-idle");

    const [restoreRow] = await live
      .select()
      .from(versions)
      .where(and(eq(versions.assetId, asset.id), eq(versions.kind, "restore")));
    expect(restoreRow).toBeDefined();
    expect(restoreRow?.label).toContain(source.id);
    expect(restoreRow?.scope).toBe("frame");
    expect(restoreRow?.frameId).toBe(frame.id);
    expect(restoreRow?.author).toBe("user");
    expect(restoreRow?.snapshot).toEqual({ name: "restored-idle", layers });
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

  it("refuses while a workspace run is bound to one of the asset's frames", async () => {
    const threadId = randomUUID();
    const runId = randomUUID();
    // A workspace thread keeps assetId NULL; the run's frame_id is the only
    // pointer to the asset it is drawing on.
    await live.insert(generationThreads).values({
      id: threadId,
      projectId,
      userId,
    });
    await live.insert(generationRuns).values({
      id: runId,
      threadId,
      requestId: randomUUID(),
      status: "running",
      modelId: "test-model",
      reasoningEffort: "low",
      frameId: frame.id,
    });
    try {
      expect(await assetHasActiveRun(live, asset.id)).toBe(true);
      const [version] = await live
        .select()
        .from(versions)
        .where(and(eq(versions.assetId, asset.id), eq(versions.kind, "edit")));
      if (!version) throw new Error("the edit version was not found");
      const result = await restoreVersion(live, userId, asset.id, version.id);
      expect(result.asset).toBeUndefined();
      expect(result.failure?.code).toBe("RUN_IN_PROGRESS");
      expect(result.failure?.message).toBe(
        "The agent is drawing on this asset right now.",
      );
    } finally {
      await live.delete(generationRuns).where(eq(generationRuns.id, runId));
      await live.delete(generationThreads).where(eq(generationThreads.id, threadId));
    }
  });

  it("keeps the lock when a workspace run's pinned frame is deleted and the pin follows", async () => {
    const threadId = randomUUID();
    const runId = randomUUID();
    const second = createAsset({ name: "second", width: 8, height: 8 }).frames[0];
    if (!second) throw new Error("createAsset produced no frame");
    await live.insert(frames).values({
      id: second.id,
      assetId: asset.id,
      name: second.name,
      index: 1,
      layers: second.layers,
    });
    await live.insert(generationThreads).values({
      id: threadId,
      projectId,
      userId,
    });
    await live.insert(generationRuns).values({
      id: runId,
      threadId,
      requestId: randomUUID(),
      status: "running",
      modelId: "test-model",
      reasoningEffort: "low",
      frameId: second.id,
    });
    try {
      expect(await assetHasActiveRun(live, asset.id)).toBe(true);
      // The worker's delete branch removes the frame row and re-pins the run
      // to a remaining frame; a live run must never silently unlock the asset
      // by leaving frame_id pointing at the deleted frame.
      await live.delete(frames).where(eq(frames.id, second.id));
      await live
        .update(generationRuns)
        .set({ frameId: frame.id })
        .where(eq(generationRuns.id, runId));
      expect(await assetHasActiveRun(live, asset.id)).toBe(true);
    } finally {
      await live.delete(generationRuns).where(eq(generationRuns.id, runId));
      await live.delete(generationThreads).where(eq(generationThreads.id, threadId));
      await live.delete(frames).where(eq(frames.id, second.id));
    }
  });

  it("replays the recorded frame order", async () => {
    const second = createAsset({ name: "second", width: 8, height: 8 }).frames[0];
    if (!second) throw new Error("createAsset produced no frame");
    await live.insert(frames).values({
      id: second.id,
      assetId: asset.id,
      name: second.name,
      index: 1,
      layers: second.layers,
    });
    const source = await createVersion(live, {
      assetId: asset.id,
      scope: "asset",
      kind: "frame-move",
      author: "user",
      snapshot: {
        name: asset.name,
        width: asset.width,
        height: asset.height,
        palette: asset.palette,
        frameIds: [second.id, frame.id],
      },
    });
    if (!source) throw new Error("createVersion inserted nothing");

    const result = await restoreVersion(live, userId, asset.id, source.id);
    expect(result.failure).toBeUndefined();
    expect(result.asset?.frames.map((item) => item.id)).toEqual([second.id, frame.id]);
  });

  it("refuses an asset snapshot whose frames do not match", async () => {
    const source = await createVersion(live, {
      assetId: asset.id,
      scope: "asset",
      kind: "frame-move",
      author: "user",
      snapshot: {
        name: asset.name,
        width: asset.width,
        height: asset.height,
        palette: asset.palette,
        frameIds: [frame.id],
      },
    });
    if (!source) throw new Error("createVersion inserted nothing");

    const result = await restoreVersion(live, userId, asset.id, source.id);
    expect(result.asset).toBeUndefined();
    expect(result.failure?.code).toBe("INVALID_VERSION");
    expect(result.failure?.message).toBe(
      "That version's frames do not match this asset.",
    );
  });
});

const threadsDb = await probe(process.env.DATABASE_URL);

describe.skipIf(!threadsDb)("ensureThread", () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const projectId = randomUUID();
  const asset = createAsset({ name: "thread-test", width: 8, height: 8 });
  const frame = asset.frames[0];
  if (!frame) throw new Error("createAsset produced no frame");
  let live: Database;

  beforeAll(async () => {
    if (!threadsDb) throw new Error("database probe did not resolve");
    live = threadsDb;
    await live.insert(user).values([
      { id: userId, name: "Thread Test", email: `thread-${userId}@test.local` },
      { id: otherUserId, name: "Other Test", email: `thread-${otherUserId}@test.local` },
    ]);
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "threads",
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
    await live.delete(user).where(eq(user.id, otherUserId));
    await live.$client.end({ timeout: 5 });
  });

  it("keys an asset thread by the asset and reuses it", async () => {
    const first = await ensureThread(live, userId, { assetId: asset.id });
    expect(first.assetId).toBe(asset.id);
    expect(first.projectId).toBeNull();
    const again = await ensureThread(live, userId, { assetId: asset.id });
    expect(again.id).toBe(first.id);
  });

  it("keys a workspace thread by the project with no asset", async () => {
    const thread = await ensureThread(live, userId, { projectId });
    expect(thread.projectId).toBe(projectId);
    expect(thread.assetId).toBeNull();
    const again = await ensureThread(live, userId, { projectId });
    expect(again.id).toBe(thread.id);
  });

  it("keeps one thread per user for the same asset", async () => {
    const mine = await ensureThread(live, userId, { assetId: asset.id });
    const theirs = await ensureThread(live, otherUserId, { assetId: asset.id });
    expect(theirs.id).not.toBe(mine.id);
  });

  it("refuses a thread with neither an asset nor a project", async () => {
    await expect(
      live.insert(generationThreads).values({ id: randomUUID(), userId }),
    ).rejects.toThrow();
  });
});

const sessionDb = await probe(process.env.DATABASE_URL);

describe.skipIf(!sessionDb)("sessionUsageForThread", () => {
  const userId = randomUUID();
  const projectId = randomUUID();
  let live: Database;

  const context = (modelId: string, usedTokens: number) => ({
    model: { modelId, context: { contextWindow: 1048576 } },
    usedTokens,
    remainingTokens: 1048576 - usedTokens,
    usedPercent: (usedTokens / 1048576) * 100,
    remainingPercent: 100 - (usedTokens / 1048576) * 100,
  });

  beforeAll(async () => {
    if (!sessionDb) throw new Error("database probe did not resolve");
    live = sessionDb;
    await live.insert(user).values({
      id: userId,
      name: "Session Test",
      email: `session-${userId}@test.local`,
    });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "session",
      style: defaultStyle,
    });
  });

  afterAll(async () => {
    if (!live) return;
    // Threads, tasks, and runs all cascade from the user.
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  it("sums settled tasks and parentless runs, never their children twice", async () => {
    const threadId = randomUUID();
    const taskId = randomUUID();
    await live.insert(generationThreads).values({ id: threadId, projectId, userId });
    // A finished task: its usage already rolled up its child, so the child's
    // own row must not be counted again. Its context is the older one.
    await live.insert(runTasks).values({
      id: taskId,
      threadId,
      status: "completed",
      phase: "review",
      createdAt: new Date("2026-10-17T10:00:00Z"),
      finishedAt: new Date("2026-10-17T10:01:00Z"),
      usage: {
        input: 100,
        cached: 20,
        output: 10,
        total: 130,
        cost: 0.5,
        context: context("muse-spark-1.3-contributor", 120_000),
      },
    });
    await live.insert(generationRuns).values({
      id: randomUUID(),
      threadId,
      taskId,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "muse-spark-1.3-contributor",
      reasoningEffort: "high",
      createdAt: new Date("2026-10-17T10:00:05Z"),
      finishedAt: new Date("2026-10-17T10:00:55Z"),
      usage: { input: 90, output: 5, total: 95, cost: 0.4 },
    });
    // A parentless ask run finishes later; its context state is the newest.
    await live.insert(generationRuns).values({
      id: randomUUID(),
      threadId,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "low",
      createdAt: new Date("2026-10-17T10:02:00Z"),
      finishedAt: new Date("2026-10-17T10:02:30Z"),
      usage: {
        input: 5,
        cached: 1,
        output: 2,
        total: 7,
        cost: 0.25,
        context: context("deepseek-v4.1-flash", 500_000),
      },
    });
    // Live rows are not settled spend.
    await live.insert(generationRuns).values({
      id: randomUUID(),
      threadId,
      requestId: randomUUID(),
      status: "running",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "low",
      usage: { cost: 9 },
    });
    await live.insert(runTasks).values({
      id: randomUUID(),
      threadId,
      status: "running",
      phase: "execute",
    });

    const session = await sessionUsageForThread(live, threadId);
    expect(session).toEqual({
      input: 105,
      cached: 21,
      output: 12,
      total: 137,
      cost: 0.75,
      elapsedMs: 90_000,
      context: context("deepseek-v4.1-flash", 500_000),
      // The newest run (still running) names the last model; the fixture's
      // unprefixed id is not in the catalog, so its window is unknown.
      modelId: "deepseek-v4.1-flash",
      contextWindow: null,
    });

    await live.delete(generationThreads).where(eq(generationThreads.id, threadId));
  });

  it("takes the newest settled context state even when it sits on a task", async () => {
    const threadId = randomUUID();
    await live.insert(generationThreads).values({ id: threadId, projectId, userId });
    await live.insert(generationRuns).values({
      id: randomUUID(),
      threadId,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "low",
      createdAt: new Date("2026-10-17T11:00:00Z"),
      finishedAt: new Date("2026-10-17T11:00:20Z"),
      usage: { context: context("deepseek-v4.1-flash", 100_000) },
    });
    await live.insert(runTasks).values({
      id: randomUUID(),
      threadId,
      status: "completed",
      phase: "review",
      createdAt: new Date("2026-10-17T11:01:00Z"),
      finishedAt: new Date("2026-10-17T11:02:00Z"),
      usage: { context: context("muse-spark-1.3-contributor", 700_000) },
    });

    const session = await sessionUsageForThread(live, threadId);
    expect(session.context).toEqual(context("muse-spark-1.3-contributor", 700_000));
    await live.delete(generationThreads).where(eq(generationThreads.id, threadId));
  });

  it("reports zeros and no context for a thread with no settled spend", async () => {
    const threadId = randomUUID();
    await live.insert(generationThreads).values({ id: threadId, projectId, userId });
    const session = await sessionUsageForThread(live, threadId);
    expect(session).toEqual({
      input: 0,
      cached: 0,
      output: 0,
      total: 0,
      cost: 0,
      elapsedMs: 0,
      context: null,
      modelId: null,
      contextWindow: null,
    });
    await live.delete(generationThreads).where(eq(generationThreads.id, threadId));
  });
});
