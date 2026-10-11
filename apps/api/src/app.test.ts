import { randomUUID } from "node:crypto";
import {
  assets,
  createDatabase,
  frames,
  generationRuns,
  generationThreads,
  projects,
  user,
  type Database,
} from "@pixelaition/db";
import { createAsset, defaultStyle } from "@pixelaition/pixel";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey } from "./store.js";

/**
 * The runs route needs a live database and a real auth secret; when either is
 * missing the suite skips instead of failing.
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
process.env.BETTER_AUTH_SECRET ??= "scope-test-secret";
const appModule = db ? await import("./app.js") : undefined;

describe.skipIf(!db)("API routes", () => {
  const userId = randomUUID();
  let live: Database;
  let app: Express;
  let token: string;

  beforeAll(async () => {
    if (!db || !appModule) throw new Error("database probe did not resolve");
    live = db;
    app = appModule.createApp();
    await live.insert(user).values({
      id: userId,
      name: "Scope Test",
      email: `scope-${userId}@test.local`,
    });
    token = (await createApiKey(live, userId, "scope-test")).token;
  });

  afterAll(async () => {
    if (!live) return;
    await live.delete(user).where(eq(user.id, userId));
    // createApp shares the auth module's connection pool; close both so the
    // test process can exit.
    const { db: appDb } = await import("./auth.js");
    await appDb.$client.end({ timeout: 5 });
    await live.$client.end({ timeout: 5 });
  });

  function postRun(body: Record<string, unknown>) {
    return request(app)
      .post("/api/runs")
      .set("authorization", `Bearer ${token}`)
      .send(body);
  }

  it("rejects a workspace run without a projectId with 422", async () => {
    const res = await postRun({
      scope: "workspace",
      prompt: "draw a knight",
      modelId: "test-model",
      reasoningEffort: "low",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SCOPE_REQUIRED");
  });

  it("rejects a run with neither an asset nor a project with 422", async () => {
    const res = await postRun({
      prompt: "draw a knight",
      modelId: "test-model",
      reasoningEffort: "low",
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("SCOPE_REQUIRED");
  });

  it("rejects a projectId the caller does not own with 404", async () => {
    const res = await postRun({
      scope: "workspace",
      projectId: randomUUID(),
      prompt: "draw a knight",
      modelId: "test-model",
      reasoningEffort: "low",
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("refuses asset writes while a bound workspace run is active", async () => {
    const projectId = randomUUID();
    const asset = createAsset({ name: "lock-test", width: 8, height: 8 });
    const frame = asset.frames[0];
    if (!frame) throw new Error("createAsset produced no frame");
    const threadId = randomUUID();
    const runId = randomUUID();
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "lock",
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
    // A workspace thread keeps assetId NULL; only the run's frame_id points at
    // the asset, so the guard must find it through frames.
    await live.insert(generationThreads).values({ id: threadId, projectId, userId });
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
      const patch = await request(app)
        .patch(`/api/assets/${asset.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({ name: "renamed" });
      expect(patch.status).toBe(409);
      expect(patch.body.code).toBe("RUN_IN_PROGRESS");
      expect(patch.body.message).toBe("The agent is drawing on this asset right now.");
      const put = await request(app)
        .put(`/api/assets/${asset.id}/frames/${frame.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({ layers: frame.layers });
      expect(put.status).toBe(409);
      expect(put.body.code).toBe("RUN_IN_PROGRESS");
    } finally {
      // Deleting the project cascades to its assets, frames, thread, and run.
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });
});
