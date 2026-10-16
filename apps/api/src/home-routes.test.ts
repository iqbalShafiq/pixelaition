import { randomUUID } from "node:crypto";
import {
  runTasks,
  createDatabase,
  generationRuns,
  models,
  projects,
  user,
  type Database,
} from "@pixelaition/db";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiKey, createAssetRecord, insertProposal } from "./store.js";

/**
 * The home route needs a live database and stubbed providers; when
 * DATABASE_URL is absent or the database cannot be reached, the suite skips.
 * This file owns its connection so another suite ending the shared client
 * cannot break it.
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
process.env.BETTER_AUTH_SECRET ??= "home-route-test-secret";

const guardrailAnswers = {
  answers: {
    sexual_content: { type: "noul", noul: 0.02 },
    graphic_violence: { type: "noul", noul: 0.01 },
    hate_or_harassment: { type: "noul", noul: 0.01 },
    self_harm: { type: "noul", noul: 0.01 },
    jailbreak: { type: "noul", noul: 0.03 },
    severity: { type: "score", score: 0.1, confidence: 0.9, probabilities: {} },
  },
  usage: { input_tokens: 400, output_tokens: 40, cost: 0.00002 },
};

describe.skipIf(!db)("home runs route", () => {
  const userId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  let live: Database;
  let app: Express;
  let token: string;
  let assetId: string;
  let otherAssetId: string;

  beforeAll(async () => {
    if (!db) throw new Error("database probe did not resolve");
    live = db;
    const appModule = await import("./app.js");
    app = appModule.createApp();
    await live.insert(user).values({
      id: userId,
      name: "Home Route Test",
      email: `home-${userId}@test.local`,
    });
    await live.insert(projects).values([
      {
        id: projectId,
        userId,
        name: "knights",
        description: "",
        summary: "armored heroes",
        style: {
          notes: "",
          outline: "#1a1c2c",
          maxColors: 8,
          defaultWidth: 32,
          defaultHeight: 32,
          shadowDirection: "down",
        },
      },
      {
        id: otherProjectId,
        userId,
        name: "potions",
        description: "",
        summary: "bottles",
        style: {
          notes: "",
          outline: "#1a1c2c",
          maxColors: 8,
          defaultWidth: 32,
          defaultHeight: 32,
          shadowDirection: "down",
        },
      },
    ]);
    const created = await createAssetRecord(live, userId, projectId, "fixture");
    if (!created) throw new Error("fixture asset was not created");
    assetId = created.id;
    const other = await createAssetRecord(live, userId, otherProjectId, "other");
    if (!other) throw new Error("other asset was not created");
    otherAssetId = other.id;
    await live
      .insert(models)
      .values({
        id: "home-test-model",
        api: "responses",
        efforts: ["low"],
        position: 0,
        enabled: true,
        vision: true,
      })
      .onConflictDoUpdate({
        target: models.id,
        set: { api: "responses", efforts: ["low"], enabled: true, vision: true },
      });
    token = (await createApiKey(live, userId, "home-route-test")).token;
    process.env.AGENT_API_KEY = "test-agent-key";
    process.env.DECISION_MODEL = "typesafe/jev-1.13";
    process.env.DECISION_MODEL_BASE_URL = "https://decisions.test";
    process.env.DECISION_MODEL_API_KEY = "test-decision-key";
  });

  afterAll(async () => {
    // The fixture model is this suite's own row; leaving it enabled once cost
    // every frame summary ("home-test-model" won vision selection by position).
    await live.delete(models).where(eq(models.id, "home-test-model"));
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let lastWorkerBody: {
    usage?: { jevCalls?: number; jevCost?: number; cost?: number };
    prompt?: string;
    mode?: string;
  } | null = null;

  function stubProviders(
    options: { workerStatus?: number; projectChoice?: string; assetChoice?: string } = {},
  ) {
    vi.stubGlobal("fetch", async (url: string | URL, init?: { body?: unknown }) => {
      const href = String(url);
      if (href.includes("/alpha/decisions")) {
        const parsed = JSON.parse(String(init?.body)) as {
          questions: Record<string, unknown>;
        };
        const keys = Object.keys(parsed.questions);
        const body = keys.includes("asset")
          ? {
              answers: {
                asset: {
                  type: "choice",
                  choice: options.assetChoice ?? "new",
                  confidence: 0.77,
                },
              },
              usage: { input_tokens: 300, output_tokens: 30, cost: 0.00001 },
            }
          : keys.includes("intent")
            ? {
                answers: {
                  intent: { type: "choice", choice: "draw", confidence: 0.9 },
                  project: {
                    type: "choice",
                    choice: options.projectChoice ?? "new",
                    confidence: 0.8,
                  },
                },
                usage: { input_tokens: 500, output_tokens: 60, cost: 0.00003 },
              }
            : guardrailAnswers;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("/internal/runs")) {
        lastWorkerBody = JSON.parse(String(init?.body)) as typeof lastWorkerBody;
        return new Response(
          JSON.stringify({ durableRunId: randomUUID(), durableTaskId: randomUUID() }),
          {
            status: options.workerStatus ?? 202,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });
  }

  const homeBody = {
    prompt: "gambar slime lompat",
    modelId: "home-test-model",
    reasoningEffort: "low",
  };

  it("refuses a confirm whose prompt differs from the proposal", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: "draw a cute cat",
      intent: "draw",
      project: { id: projectId, confidence: 0.8 },
      guardrail: { action: "pass" },
      decision: { usage: { input: 100, output: 10, total: 110, cost: 0.00001 } },
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        prompt: "draw something the guardrail would block",
        proposalId: row.id,
        confirm: { projectId, assetId: null, mode: "generate" },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PROMPT_MISMATCH");
  });

  it("refuses an asset that belongs to another project", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: homeBody.prompt,
      intent: "draw",
      project: { id: projectId, confidence: 0.8 },
      guardrail: { action: "pass" },
      decision: { usage: { input: 100, output: 10, total: 110, cost: 0.00001 } },
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        proposalId: row.id,
        confirm: { projectId, assetId: otherAssetId, mode: "generate" },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("ASSET_NOT_IN_PROJECT");
  });

  it("accumulates every decision call's usage into the proposal", async () => {
    stubProviders({ projectChoice: projectId, assetChoice: assetId });
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send(homeBody);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.proposal).toMatchObject({
      project: { id: projectId },
      asset: { id: assetId },
    });
    const [row] = await live
      .select()
      .from((await import("@pixelaition/db")).runProposals)
      .where(eq((await import("@pixelaition/db")).runProposals.id, res.body.proposalId));
    const decision = row?.decision as {
      usage?: { input?: number; cost?: number };
    } | null;
    // 500 from the intent+project call plus 300 from the asset call.
    expect(decision?.usage?.input).toBe(800);
    expect(decision?.usage?.cost).toBeCloseTo(0.00004, 6);
  });

  it("proposes a target and starts no run", async () => {
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send(homeBody);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.proposalId).toBeTruthy();
    expect(res.body.proposal).toMatchObject({
      intent: "draw",
      project: { id: "new", confidence: 0.8 },
    });
    const runs = await live
      .select({ id: generationRuns.id })
      .from(generationRuns)
      .where(eq(generationRuns.prompt, homeBody.prompt));
    expect(runs).toHaveLength(0);
  });

  it("refuses an unknown proposal with 404", async () => {
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        proposalId: randomUUID(),
        confirm: { projectId, assetId: null, mode: "generate" },
      });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });

  it("refuses a consumed proposal with 409", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: homeBody.prompt,
      intent: "draw",
      project: { id: projectId, confidence: 0.8 },
      guardrail: { action: "pass" },
      decision: { usage: { input: 100, output: 10, total: 110, cost: 0.00001 } },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await live
      .update((await import("@pixelaition/db")).runProposals)
      .set({ consumedAt: new Date() })
      .where(eq((await import("@pixelaition/db")).runProposals.id, row.id));
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        proposalId: row.id,
        confirm: { projectId, assetId: null, mode: "generate" },
      });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("PROPOSAL_CONSUMED");
  });

  it("requires a name for a new project", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: homeBody.prompt,
      intent: "draw",
      project: { id: "new", confidence: 0.6 },
      guardrail: { action: "pass" },
      decision: { usage: { input: 100, output: 10, total: 110, cost: 0.00001 } },
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        proposalId: row.id,
        confirm: { projectId: "new", assetId: null, mode: "generate" },
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("PROJECT_NAME_REQUIRED");
  });

  it("starts a workspace run on confirm and seeds the Jev spend", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: homeBody.prompt,
      intent: "draw",
      project: { id: projectId, confidence: 0.8 },
      guardrail: {
        action: "pass",
        hazards: {},
        severity: 0.1,
        usage: { input: 400, output: 40, total: 440, cost: 0.00002 },
      },
      decision: { usage: { input: 500, output: 60, total: 560, cost: 0.00003 } },
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        proposalId: row.id,
        confirm: { projectId, assetId: null, mode: "generate" },
      });
    expect(res.status).toBe(202);
    const [task] = await live
      .select()
      .from(runTasks)
      .where(eq(runTasks.id, res.body.runId));
    expect(task?.status).toBe("running");
    // The worker request carries the proposal's Jev spend as the run's seed;
    // the worker persists it into the run row as the run progresses.
    expect(lastWorkerBody?.usage).toMatchObject({ jevCalls: 2, jevCost: 0.00005 });
    expect(lastWorkerBody?.mode).toBe("draw");
  });

  it("returns the new asset and its project so the home can open the editor", async () => {
    const row = await insertProposal(live, {
      userId,
      prompt: "gambar slime lompat",
      intent: "draw",
      project: { id: projectId, confidence: 0.8 },
      guardrail: { action: "pass" },
      decision: { usage: { input: 100, output: 10, total: 110, cost: 0.00001 } },
      expiresAt: new Date(Date.now() + 60_000),
    });
    stubProviders();
    const res = await request(app)
      .post("/api/home/runs")
      .set("authorization", `Bearer ${token}`)
      .send({
        ...homeBody,
        proposalId: row.id,
        confirm: {
          projectId,
          assetId: "new",
          assetName: "slime-lompat",
          mode: "generate",
        },
      });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.kind).toBe("task");
    expect(res.body.projectId).toBe(projectId);
    expect(typeof res.body.assetId).toBe("string");
    expect(res.body.assetId).not.toBe(assetId);
    expect(lastWorkerBody?.prompt).toContain("Asset name to use: slime-lompat");
  });
});
