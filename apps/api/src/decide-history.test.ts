import { randomUUID } from "node:crypto";
import {
  createDatabase,
  generationRuns,
  generationThreads,
  models,
  projects,
  runTasks,
  user,
  type Database,
} from "@pixelaition/db";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApiKey, createAssetRecord } from "./store.js";

/**
 * The decide call must read the user's turns, not the machinery of an earlier
 * drawing task: supervisor/worker/review/fix prompts once crowded the window
 * and turned an edit request into a read-only ask. The suite needs a live
 * database and stubbed providers; when either is missing it skips.
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
process.env.BETTER_AUTH_SECRET ??= "decide-history-test-secret";

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

/** The decide battery's answers, with the ask/action knobs under test. */
function intentAnswers(
  over: { intentChoice?: string; intentConfidence?: number; actsOnArt?: number } = {},
) {
  return {
    answers: {
      intent: {
        type: "choice",
        choice: over.intentChoice ?? "ask",
        confidence: over.intentConfidence ?? 0.95,
      },
      drawable: { type: "noul", noul: 0.9 },
      actionable: { type: "noul", noul: 0.9 },
      workers: { type: "choice", choice: "1" },
      review: { type: "noul", noul: 0.2 },
      acts_on_art: { type: "noul", noul: over.actsOnArt ?? 0.97 },
    },
    usage: { input_tokens: 500, output_tokens: 60, cost: 0.00003 },
  };
}

describe.skipIf(!db)("decision history", () => {
  const userId = randomUUID();
  const projectId = randomUUID();
  let live: Database;
  let app: Express;
  let token: string;
  let assetId: string;
  let frameId: string;
  let threadId: string;

  let decideState: { history?: unknown } | null = null;
  let lastWorkerBody: { mode?: string } | null = null;

  function stubProviders(decision: object) {
    vi.stubGlobal("fetch", async (url: string | URL, init?: { body?: unknown }) => {
      const href = String(url);
      if (href.includes("/alpha/decisions")) {
        const parsed = JSON.parse(String(init?.body)) as {
          state: { history?: unknown };
          questions: Record<string, unknown>;
        };
        const body = "intent" in parsed.questions ? decision : guardrailAnswers;
        if ("intent" in parsed.questions) decideState = parsed.state;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("/internal/runs")) {
        lastWorkerBody = JSON.parse(String(init?.body)) as typeof lastWorkerBody;
        return new Response(
          JSON.stringify({ durableRunId: randomUUID(), durableTaskId: randomUUID() }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch: ${href}`);
    });
  }

  function postRun(prompt: string) {
    return request(app).post("/api/runs").set("authorization", `Bearer ${token}`).send({
      prompt,
      modelId: "history-test-model",
      reasoningEffort: "low",
      scope: "asset",
      assetId,
      frameId,
    });
  }

  beforeAll(async () => {
    if (!db) throw new Error("database probe did not resolve");
    live = db;
    const appModule = await import("./app.js");
    app = appModule.createApp();
    await live.insert(user).values({
      id: userId,
      name: "Decide History Test",
      email: `decide-history-${userId}@test.local`,
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
    const created = await createAssetRecord(live, userId, projectId, "scoups");
    if (!created) throw new Error("fixture asset was not created");
    assetId = created.id;
    frameId = created.frames[0]?.id ?? "";
    threadId = randomUUID();
    await live.insert(generationThreads).values({ id: threadId, assetId, userId });
    // The exact shape this test guards against: user turns around a drawing
    // task's machinery, newest row last.
    const at = (seconds: number) => new Date(1_760_000_000_000 + seconds * 1000);
    await live.insert(generationRuns).values([
      {
        id: randomUUID(),
        threadId,
        requestId: randomUUID(),
        frameId,
        status: "succeeded",
        modelId: "history-test-model",
        reasoningEffort: "low",
        prompt: "warna rambut di frame ini apa?",
        answer: "Cokelat.",
        createdAt: at(1),
      },
      {
        id: randomUUID(),
        threadId,
        requestId: randomUUID(),
        frameId,
        status: "succeeded",
        modelId: "history-test-model",
        reasoningEffort: "low",
        role: "plan",
        workerKey: "plan",
        prompt: "perbesar kanvas lalu rapikan wajahnya\n\nAsset name to use: scoups",
        answer: null,
        createdAt: at(2),
      },
      {
        id: randomUUID(),
        threadId,
        requestId: randomUUID(),
        frameId,
        status: "succeeded",
        modelId: "history-test-model",
        reasoningEffort: "low",
        role: "worker",
        workerKey: "w1",
        prompt:
          "You are one worker in a supervised team; you paint only the frames you own.",
        answer: "Painted the hair.",
        createdAt: at(3),
      },
      {
        id: randomUUID(),
        threadId,
        requestId: randomUUID(),
        frameId,
        status: "succeeded",
        modelId: "history-test-model",
        reasoningEffort: "low",
        role: "review",
        workerKey: "review-1",
        prompt: "You are the supervisor's review pass; you never paint.",
        answer: '{"ok":false}',
        createdAt: at(4),
      },
      {
        id: randomUUID(),
        threadId,
        requestId: randomUUID(),
        frameId,
        status: "succeeded",
        modelId: "history-test-model",
        reasoningEffort: "low",
        role: "fix",
        workerKey: "fix-1-1",
        prompt: "You are a fix worker; you paint only the frames named in your task.",
        answer: "Repainted the face.",
        createdAt: at(5),
      },
      {
        id: randomUUID(),
        threadId,
        requestId: randomUUID(),
        frameId,
        status: "succeeded",
        modelId: "history-test-model",
        reasoningEffort: "low",
        role: "plan",
        workerKey: "plan-1",
        prompt: "The user already approved this plan. Do not call present_plan.",
        answer: null,
        createdAt: at(6),
      },
    ]);
    await live
      .insert(models)
      .values({
        id: "history-test-model",
        displayName: "History Test Model",
        api: "responses",
        efforts: ["low"],
        position: 0,
        enabled: true,
        vision: true,
      })
      .onConflictDoUpdate({
        target: models.id,
        set: {
          displayName: "History Test Model",
          api: "responses",
          efforts: ["low"],
          enabled: true,
          vision: true,
        },
      });
    token = (await createApiKey(live, userId, "decide-history-test")).token;
    process.env.AGENT_API_KEY = "test-agent-key";
    process.env.DECISION_MODEL = "typesafe/jev-1.13";
    process.env.DECISION_MODEL_BASE_URL = "https://decisions.test";
    process.env.DECISION_MODEL_API_KEY = "test-decision-key";
  });

  afterEach(async () => {
    // The provider stub accepts runs but never finishes them; settle the rows
    // so a later draw request is not refused as a second active run.
    await live
      .update(generationRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(generationRuns.threadId, threadId));
    await live
      .update(runTasks)
      .set({ status: "succeeded" })
      .where(eq(runTasks.threadId, threadId));
    decideState = null;
    lastWorkerBody = null;
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await live.delete(models).where(eq(models.id, "history-test-model"));
    await live.delete(user).where(eq(user.id, userId));
    await live.$client.end({ timeout: 5 });
  });

  it("shows only user turns in the console's earlier-runs list", async () => {
    const res = await request(app)
      .get(`/api/assets/${assetId}/active-run`)
      .query({ frameId })
      .set("authorization", `Bearer ${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      (res.body.history as Array<{ prompt: string }>).map((item) => item.prompt),
    ).toEqual([
      "perbesar kanvas lalu rapikan wajahnya",
      "warna rambut di frame ini apa?",
    ]);
  });

  it("decides from the user's turns, not the task machinery", async () => {
    stubProviders(intentAnswers());
    const res = await postRun("bisa nggak kanvasnya diperbesar biar lebih detail?");
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(decideState?.history).toEqual([
      { prompt: "warna rambut di frame ini apa?", answer: "Cokelat." },
      { prompt: "perbesar kanvas lalu rapikan wajahnya" },
    ]);
  });

  it("runs a low-confidence ask whose message asks for a change", async () => {
    stubProviders(intentAnswers({ intentConfidence: 0.4, actsOnArt: 0.97 }));
    const res = await postRun("kayak masih belum mirip nih dengan wajah aslinya");
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.kind).toBe("task");
    expect(lastWorkerBody?.mode).toBe("draw");
  });

  it("keeps a decisive ask read-only", async () => {
    stubProviders(intentAnswers({ intentConfidence: 0.95, actsOnArt: 0.97 }));
    const res = await postRun("berapa warna di palet sekarang?");
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.kind).toBe("run");
    expect(lastWorkerBody?.mode).toBe("ask");
  });
});
