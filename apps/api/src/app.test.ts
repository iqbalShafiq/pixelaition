import { randomUUID } from "node:crypto";
import {
  assets,
  createDatabase,
  frames,
  generationRuns,
  generationThreads,
  projects,
  runTasks,
  user,
  type Database,
} from "@pixelaition/db";
import { createAsset, defaultStyle } from "@pixelaition/pixel";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiKey, ensureThread } from "./store.js";

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

  it("creates, edits, checks, previews, and exports a social kit", async () => {
    const project = await request(app)
      .post("/api/projects")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "social routes" });
    expect(project.status).toBe(201);
    const asset = await request(app)
      .post(`/api/projects/${project.body.id}/assets`)
      .set("authorization", `Bearer ${token}`)
      .send({ name: "orbit" });
    expect(asset.status).toBe(201);
    try {
      const created = await request(app)
        .post(`/api/projects/${project.body.id}/sets`)
        .set("authorization", `Bearer ${token}`)
        .send({
          assetId: asset.body.id,
          presetIds: ["linkedin-profile", "instagram-post"],
        });
      expect(created.status).toBe(201);
      expect(created.body.artboards).toHaveLength(2);
      const board = created.body.artboards[0];
      expect(board.width).toBe(400);
      expect(board.scene.elements.length).toBeGreaterThan(0);

      const preview = await request(app)
        .get(`/api/artboards/${board.id}/preview`)
        .set("authorization", `Bearer ${token}`);
      expect(preview.status).toBe(200);
      expect(preview.headers["content-type"]).toBe("image/png");
      expect((preview.body as Buffer).readUInt32BE(16)).toBe(400);
      expect((preview.body as Buffer).readUInt32BE(20)).toBe(400);

      const state = await request(app)
        .get(`/api/sets/${created.body.id}/state`)
        .set("authorization", `Bearer ${token}`);
      expect(state.status).toBe(200);
      expect(state.body.artboards).toHaveLength(2);
      expect(state.body.summary.errors).toBe(0);

      const patched = await request(app)
        .patch(`/api/artboards/${board.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({ version: board.version, name: "LinkedIn avatar", status: "ready" });
      expect(patched.status).toBe(200);
      expect(patched.body.artboard.version).toBe(board.version + 1);

      const stale = await request(app)
        .patch(`/api/artboards/${board.id}`)
        .set("authorization", `Bearer ${token}`)
        .send({ version: board.version, name: "stale" });
      expect(stale.status).toBe(409);

      const png = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "artboard", artboardId: board.id, format: "png" });
      expect(png.status).toBe(200);
      expect(png.headers["content-type"]).toBe("image/png");

      const zip = await request(app)
        .post("/api/export")
        .set("authorization", `Bearer ${token}`)
        .send({ scope: "set", setId: created.body.id, format: "zip" });
      expect(zip.status).toBe(200);
      expect(zip.headers["content-type"]).toBe("application/zip");
    } finally {
      await live.delete(projects).where(eq(projects.id, project.body.id));
    }
  });

  it("adds a social frame to a sprite asset, saves its scene, reads resources, and exports it", async () => {
    const project = await request(app)
      .post("/api/projects")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "mixed frames" });
    expect(project.status).toBe(201);
    const asset = await request(app)
      .post(`/api/projects/${project.body.id}/assets`)
      .set("authorization", `Bearer ${token}`)
      .send({ name: "orbit mixed" });
    expect(asset.status).toBe(201);
    try {
      const added = await request(app)
        .post(`/api/assets/${asset.body.id}/frames`)
        .set("authorization", `Bearer ${token}`)
        .send({
          kind: "social",
          presetId: "linkedin-cover",
          copy: { headline: "Orbit is live", subhead: "One mark, every feed." },
        });
      expect(added.status).toBe(201);
      const social = added.body.frames.find(
        (frame: { kind?: string }) => frame.kind === "social",
      );
      expect(social.presetId).toBe("linkedin-cover");
      expect(social.width).toBe(1584);
      expect(social.scene.elements.length).toBeGreaterThan(0);

      const resources = await request(app)
        .get(`/api/projects/${project.body.id}/resources`)
        .set("authorization", `Bearer ${token}`);
      expect(resources.status).toBe(200);
      expect(resources.body.assets[0].frames).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "sprite" }),
          expect.objectContaining({ kind: "social", presetId: "linkedin-cover" }),
        ]),
      );

      const saved = await request(app)
        .patch(`/api/assets/${asset.body.id}/frames/${social.id}/scene`)
        .set("authorization", `Bearer ${token}`)
        .send({ version: social.version, name: "Launch cover", status: "ready" });
      expect(saved.status).toBe(200);
      expect(
        saved.body.frames.find((frame: { id: string }) => frame.id === social.id).name,
      ).toBe("Launch cover");

      const stale = await request(app)
        .patch(`/api/assets/${asset.body.id}/frames/${social.id}/scene`)
        .set("authorization", `Bearer ${token}`)
        .send({ version: social.version, status: "ready" });
      expect(stale.status).toBe(409);

      await request(app)
        .patch(`/api/assets/${asset.body.id}/copy`)
        .set("authorization", `Bearer ${token}`)
        .send({
          copy: {
            eyebrow: "ORBIT",
            headline: "Orbit is live",
            subhead: "One mark, every feed.",
            cta: "Make yours",
            handle: "@orbit",
          },
        });

      const target = await request(app)
        .post(`/api/projects/${project.body.id}/assets`)
        .set("authorization", `Bearer ${token}`)
        .send({ name: "import target" });
      expect(target.status).toBe(201);
      const spriteFrame = added.body.frames.find(
        (frame: { kind?: string }) => frame.kind !== "social",
      );
      const importedSprite = await request(app)
        .post(`/api/assets/${target.body.id}/frames/import`)
        .set("authorization", `Bearer ${token}`)
        .send({
          sourceAssetId: asset.body.id,
          sourceFrameId: spriteFrame.id,
        });
      expect(importedSprite.status).toBe(201);
      expect(
        importedSprite.body.asset.frames.some(
          (frame: { kind?: string }) => frame.kind === "sprite",
        ),
      ).toBe(true);
      const importedSocial = await request(app)
        .post(`/api/assets/${target.body.id}/frames/import`)
        .set("authorization", `Bearer ${token}`)
        .send({
          sourceAssetId: asset.body.id,
          sourceFrameId: social.id,
        });
      expect(importedSocial.status).toBe(201);
      const copied = importedSocial.body.asset.frames.find(
        (frame: { kind?: string; presetId?: string }) =>
          frame.presetId === "linkedin-cover" && frame.kind === "social",
      );
      expect(copied.width).toBe(1584);
      expect(copied.scene.elements.length).toBeGreaterThan(0);
      expect(importedSocial.body.asset.copy.headline).toBe("Orbit is live");

      const background = await request(app)
        .post(
          `/api/assets/${target.body.id}/frames/${importedSocial.body.frameId}/background`,
        )
        .set("authorization", `Bearer ${token}`)
        .send({ sourceAssetId: asset.body.id, sourceFrameId: social.id });
      expect(background.status).toBe(200);
      expect(
        background.body.frames.find(
          (frame: { id: string }) => frame.id === importedSocial.body.frameId,
        ).version,
      ).toBeGreaterThan(copied.version);

      const png = await request(app)
        .post(`/api/assets/${asset.body.id}/social-export`)
        .set("authorization", `Bearer ${token}`)
        .send({ frameId: social.id, format: "png" });
      expect(png.status).toBe(200);
      expect(png.headers["content-type"]).toBe("image/png");
      expect((png.body as Buffer).readUInt32BE(16)).toBe(1584);
      expect((png.body as Buffer).readUInt32BE(20)).toBe(396);
    } finally {
      await live.delete(projects).where(eq(projects.id, project.body.id));
    }
  });

  it("surfaces a bound workspace run as the asset's active run with its card", async () => {
    const projectId = randomUUID();
    const asset = createAsset({ name: "bound-run", width: 8, height: 8 });
    const frame = asset.frames[0];
    if (!frame) throw new Error("createAsset produced no frame");
    const threadId = randomUUID();
    const runId = randomUUID();
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "bound",
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
    await live.insert(generationThreads).values({ id: threadId, projectId, userId });
    await live.insert(generationRuns).values({
      id: runId,
      threadId,
      requestId: randomUUID(),
      status: "waiting",
      modelId: "test-model",
      reasoningEffort: "low",
      frameId: frame.id,
      events: [
        {
          sequence: 1,
          type: "interaction",
          data: {
            id: "i-bound",
            type: "tool-approval",
            toolName: "present_plan",
            input: {},
          },
        },
      ],
    });
    try {
      const res = await request(app)
        .get(`/api/assets/${asset.id}/active-run`)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.run).toMatchObject({
        id: runId,
        status: "waiting",
        modelId: "test-model",
      });
      expect(res.body.interaction).toMatchObject({
        id: "i-bound",
        toolName: "present_plan",
      });
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("refuses a stage override when the pending card is not a plan", async () => {
    const projectId = randomUUID();
    const threadId = randomUUID();
    const runId = randomUUID();
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "gate",
      style: defaultStyle,
    });
    await live.insert(generationThreads).values({ id: threadId, projectId, userId });
    await live.insert(generationRuns).values({
      id: runId,
      threadId,
      requestId: randomUUID(),
      status: "waiting",
      modelId: "test-model",
      reasoningEffort: "low",
      events: [
        {
          sequence: 1,
          type: "interaction",
          data: {
            id: "i-gate",
            type: "tool-approval",
            toolName: "paint_stroke",
            input: {},
          },
        },
      ],
    });
    try {
      const body = {
        interactionId: "i-gate",
        frames: [{ name: "hop", description: "a hop" }],
      };
      const refused = await request(app)
        .post(`/api/runs/${runId}/stage-override`)
        .set("authorization", `Bearer ${token}`)
        .send(body);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("NOT_A_PLAN");
      // The same card as a plan proposal accepts the edit.
      await live
        .update(generationRuns)
        .set({
          events: [
            {
              sequence: 1,
              type: "interaction",
              data: {
                id: "i-gate",
                type: "tool-approval",
                toolName: "present_plan",
                input: {},
              },
            },
          ],
        })
        .where(eq(generationRuns.id, runId));
      const accepted = await request(app)
        .post(`/api/runs/${runId}/stage-override`)
        .set("authorization", `Bearer ${token}`)
        .send(body);
      expect(accepted.status).toBe(204);
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("requires a session for the recent runs", async () => {
    const res = await request(app).get("/api/runs/recent");
    expect(res.status).toBe(401);
  });

  it("lists the caller's recent runs with the asset link target", async () => {
    const projectId = randomUUID();
    const threadId = randomUUID();
    const runId = randomUUID();
    const assetId = randomUUID();
    const otherUserId = randomUUID();
    const otherProjectId = randomUUID();
    const otherThreadId = randomUUID();
    const otherRunId = randomUUID();
    // The event names the asset's own project, which is not the thread's home:
    // the endpoint must pair the asset with the project it was created in.
    const eventProjectId = randomUUID();
    const unnamedAssetId = randomUUID();
    const unnamedRunId = randomUUID();
    await live.insert(user).values({
      id: otherUserId,
      name: "Other User",
      email: `other-${otherUserId}@test.local`,
    });
    await live.insert(projects).values([
      { id: projectId, userId, name: "recent", style: defaultStyle },
      { id: otherProjectId, userId: otherUserId, name: "theirs", style: defaultStyle },
    ]);
    await live.insert(generationThreads).values([
      { id: threadId, projectId, userId },
      { id: otherThreadId, projectId: otherProjectId, userId: otherUserId },
    ]);
    await live.insert(generationRuns).values([
      {
        id: runId,
        threadId,
        requestId: randomUUID(),
        status: "succeeded",
        modelId: "test-model",
        reasoningEffort: "low",
        prompt: "buat slime biru 32px",
        events: [
          { sequence: 1, type: "status", data: { status: "completed" } },
          {
            sequence: 2,
            type: "asset-created",
            data: { assetId, projectId: eventProjectId, name: "slime-biru" },
          },
        ],
      },
      {
        id: otherRunId,
        threadId: otherThreadId,
        requestId: randomUUID(),
        status: "succeeded",
        modelId: "test-model",
        reasoningEffort: "low",
        prompt: "not mine",
      },
    ]);
    // A long run can evict its early `asset-created` from the retained events;
    // the run's pinned frame still names the asset it touched.
    const boundAsset = createAsset({ name: "bound-slime", width: 8, height: 8 });
    const boundFrame = boundAsset.frames[0];
    if (!boundFrame) throw new Error("createAsset produced no frame");
    const boundRunId = randomUUID();
    await live.insert(assets).values({
      id: boundAsset.id,
      projectId,
      name: boundAsset.name,
      width: boundAsset.width,
      height: boundAsset.height,
      palette: boundAsset.palette,
    });
    await live.insert(frames).values({
      id: boundFrame.id,
      assetId: boundAsset.id,
      name: boundFrame.name,
      index: boundFrame.index,
      layers: boundFrame.layers,
    });
    await live.insert(generationRuns).values({
      id: boundRunId,
      threadId,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "test-model",
      reasoningEffort: "low",
      prompt: "use an existing asset",
      frameId: boundFrame.id,
    });
    // An event that names its asset but not the asset's name: the id must not
    // be paired with a name read from the database for another asset.
    await live.insert(generationRuns).values({
      id: unnamedRunId,
      threadId,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "test-model",
      reasoningEffort: "low",
      prompt: "create an unnamed asset",
      frameId: boundFrame.id,
      events: [
        {
          sequence: 1,
          type: "asset-created",
          data: { assetId: unnamedAssetId, projectId: eventProjectId },
        },
      ],
    });
    // A waiting workspace run carries its pending card so the home can
    // restore it without the retained stream.
    const waitingRunId = randomUUID();
    await live.insert(generationRuns).values({
      id: waitingRunId,
      threadId,
      requestId: randomUUID(),
      status: "waiting",
      modelId: "test-model",
      reasoningEffort: "low",
      prompt: "wait for the plan",
      frameId: boundFrame.id,
      events: [
        {
          sequence: 1,
          type: "interaction",
          data: {
            id: "i-recent",
            type: "tool-approval",
            toolName: "present_plan",
            input: {},
          },
        },
      ],
    });
    try {
      const res = await request(app)
        .get("/api/runs/recent")
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const row = (res.body.runs as Array<Record<string, unknown>>).find(
        (item) => item.id === runId,
      );
      expect(row).toMatchObject({
        id: runId,
        status: "succeeded",
        prompt: "buat slime biru 32px",
        assetId,
        projectId: eventProjectId,
        assetName: "slime-biru",
        scope: "workspace",
      });
      expect(typeof row?.createdAt).toBe("string");
      const waitingRow = (res.body.runs as Array<Record<string, unknown>>).find(
        (item) => item.id === waitingRunId,
      );
      expect(waitingRow).toMatchObject({
        id: waitingRunId,
        status: "waiting",
        scope: "workspace",
        interaction: { id: "i-recent", toolName: "present_plan" },
      });
      const boundRow = (res.body.runs as Array<Record<string, unknown>>).find(
        (item) => item.id === boundRunId,
      );
      expect(boundRow).toMatchObject({
        id: boundRunId,
        assetId: boundAsset.id,
        projectId,
        assetName: "bound-slime",
      });
      const unnamedRow = (res.body.runs as Array<Record<string, unknown>>).find(
        (item) => item.id === unnamedRunId,
      );
      expect(unnamedRow).toMatchObject({
        id: unnamedRunId,
        assetId: unnamedAssetId,
        projectId: eventProjectId,
      });
      expect(unnamedRow?.assetName).toBeUndefined();
      expect(
        (res.body.runs as Array<{ id: string }>).some((item) => item.id === otherRunId),
      ).toBe(false);
      expect(res.body.runs.length).toBeLessThanOrEqual(10);
    } finally {
      // Deleting the second user cascades their project, thread, and run.
      await live.delete(user).where(eq(user.id, otherUserId));
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  const contextFor = (modelId: string, usedTokens: number) => ({
    model: { modelId, context: { contextWindow: 1048576 } },
    usedTokens,
    remainingTokens: 1048576 - usedTokens,
    usedPercent: (usedTokens / 1048576) * 100,
    remainingPercent: 100 - (usedTokens / 1048576) * 100,
  });

  it("serves the asset conversation's session totals on their own route", async () => {
    const projectId = randomUUID();
    const asset = createAsset({ name: "session-endpoint", width: 8, height: 8 });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "session-route",
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
    const thread = await ensureThread(live, userId, { assetId: asset.id });
    await live.insert(generationRuns).values({
      id: randomUUID(),
      threadId: thread.id,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "low",
      createdAt: new Date("2026-10-17T10:00:00Z"),
      finishedAt: new Date("2026-10-17T10:00:20Z"),
      usage: { cost: 0.25, context: contextFor("deepseek-v4.1-flash", 500_000) },
    });
    try {
      const res = await request(app)
        .get(`/api/assets/${asset.id}/session`)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.session).toMatchObject({ cost: 0.25, elapsedMs: 20_000 });
      expect(res.body.session.context).toEqual(
        contextFor("deepseek-v4.1-flash", 500_000),
      );
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("returns the asset conversation's session totals with the active run", async () => {
    const projectId = randomUUID();
    const asset = createAsset({ name: "session-run", width: 8, height: 8 });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "session",
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
    const thread = await ensureThread(live, userId, { assetId: asset.id });
    // A settled drawing task, then a newer settled ask run: the header's
    // session totals cover both, and the newest context state is the run's.
    await live.insert(runTasks).values({
      id: randomUUID(),
      threadId: thread.id,
      assetId: asset.id,
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
        context: contextFor("muse-spark-1.3-contributor", 120_000),
      },
    });
    const runId = randomUUID();
    await live.insert(generationRuns).values({
      id: runId,
      threadId: thread.id,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "low",
      prompt: "make it glow",
      answer: "done",
      createdAt: new Date("2026-10-17T10:02:00Z"),
      finishedAt: new Date("2026-10-17T10:02:30Z"),
      usage: {
        input: 5,
        cached: 1,
        output: 2,
        total: 7,
        cost: 0.25,
        context: contextFor("deepseek-v4.1-flash", 500_000),
      },
    });
    try {
      const res = await request(app)
        .get(`/api/assets/${asset.id}/active-run`)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.run).toBeNull();
      expect(res.body.lastRun).toMatchObject({
        id: runId,
        status: "succeeded",
        modelId: "deepseek-v4.1-flash",
        reasoningEffort: "low",
        prompt: "make it glow",
        durationMs: 30_000,
      });
      expect(res.body.lastRun.usage.cost).toBe(0.25);
      expect(res.body.lastRun.createdAt).toBe("2026-10-17T10:02:00.000Z");
      expect(res.body.history[0]).toMatchObject({
        id: runId,
        modelId: "deepseek-v4.1-flash",
        reasoningEffort: "low",
      });
      expect(res.body.session).toMatchObject({
        cost: 0.75,
        input: 105,
        cached: 21,
        output: 12,
        total: 137,
        elapsedMs: 90_000,
      });
      expect(res.body.session.context.model.modelId).toBe("deepseek-v4.1-flash");
    } finally {
      // Deleting the project cascades its asset, thread, runs, and tasks.
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("carries each task's usage, model, and timing into the task log", async () => {
    const projectId = randomUUID();
    const asset = createAsset({ name: "log-meta", width: 8, height: 8 });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "log",
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
    const thread = await ensureThread(live, userId, { assetId: asset.id });
    const makeTask = async (
      request: string,
      modelId: string,
      effort: string,
      startedAt: string,
      cost: number,
    ) => {
      const taskId = randomUUID();
      const started = new Date(startedAt);
      const finished = new Date(started.getTime() + 60_000);
      await live.insert(runTasks).values({
        id: taskId,
        threadId: thread.id,
        assetId: asset.id,
        status: "completed",
        phase: "review",
        createdAt: started,
        finishedAt: finished,
        usage: { cost, context: contextFor(modelId, 200_000) },
      });
      await live.insert(generationRuns).values({
        id: randomUUID(),
        threadId: thread.id,
        taskId,
        requestId: randomUUID(),
        role: "worker",
        workerKey: "w1",
        status: "succeeded",
        modelId,
        reasoningEffort: effort,
        prompt: `Request: ${request}\nPaint only`,
        createdAt: started,
        finishedAt: new Date(started.getTime() + 30_000),
      });
      return { taskId, finished };
    };
    const first = await makeTask(
      "draw a slime",
      "muse-spark-1.3-contributor",
      "high",
      "2026-10-17T09:00:00Z",
      0.4,
    );
    const second = await makeTask(
      "add a glow",
      "deepseek-v4.1-flash",
      "low",
      "2026-10-17T10:00:00Z",
      0.6,
    );
    try {
      const res = await request(app)
        .get(`/api/assets/${asset.id}/task/log`)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.task.id).toBe(second.taskId);
      expect(res.body.prompt).toBe("add a glow");
      expect(res.body.modelId).toBe("deepseek-v4.1-flash");
      expect(res.body.effort).toBe("low");
      expect(res.body.usage.cost).toBe(0.6);
      expect(res.body.createdAt).toBe("2026-10-17T10:00:00.000Z");
      expect(res.body.finishedAt).toBe(second.finished.toISOString());
      expect(res.body.runs[0]).toMatchObject({ status: "succeeded" });
      expect(res.body.earlier).toHaveLength(1);
      expect(res.body.earlier[0]).toMatchObject({
        id: first.taskId,
        prompt: "draw a slime",
        modelId: "muse-spark-1.3-contributor",
        effort: "high",
        usage: { cost: 0.4 },
      });
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });

  it("replays an ask-only run as its own turn of the asset log", async () => {
    const projectId = randomUUID();
    const asset = createAsset({ name: "log-ask", width: 8, height: 8 });
    await live.insert(projects).values({
      id: projectId,
      userId,
      name: "log-ask",
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
    const thread = await ensureThread(live, userId, { assetId: asset.id });
    // The newest request asked instead of drawing: one run with no task.
    const askId = randomUUID();
    await live.insert(generationRuns).values({
      id: askId,
      threadId: thread.id,
      requestId: randomUUID(),
      status: "succeeded",
      modelId: "deepseek-v4.1-flash",
      reasoningEffort: "low",
      prompt: "which colors do I have?",
      answer: "Six, from navy to erase.",
      events: [
        {
          sequence: 1,
          type: "model_note",
          data: { operationId: "0:model:1", channel: "message", text: "reading" },
        },
      ],
      usage: { cost: 0.05 },
      createdAt: new Date("2026-10-17T11:00:00Z"),
      finishedAt: new Date("2026-10-17T11:00:20Z"),
    });
    try {
      const res = await request(app)
        .get(`/api/assets/${asset.id}/task/log`)
        .set("authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      // No drawing task on this asset, so this response is the only history
      // the console has. The ask must still be a full turn with its steps.
      expect(res.body.task).toBeNull();
      expect(res.body.prompt).toBe("which colors do I have?");
      expect(res.body.modelId).toBe("deepseek-v4.1-flash");
      expect(res.body.createdAt).toBe("2026-10-17T11:00:00.000Z");
      expect(res.body.runs).toHaveLength(1);
      expect(res.body.runs[0]).toMatchObject({
        id: askId,
        role: null,
        status: "succeeded",
        answer: "Six, from navy to erase.",
        events: [{ type: "model_note" }],
      });
      expect(res.body.earlier).toEqual([]);
    } finally {
      await live.delete(projects).where(eq(projects.id, projectId));
    }
  });
});
