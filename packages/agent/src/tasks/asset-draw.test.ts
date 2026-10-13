import type { TaskContext, TaskTransition } from "@anvia/durable";
import { describe, expect, it } from "vitest";
import {
  buildPlanPrompt,
  createAssetDrawTask,
  parsePlanOutput,
  type AssetDrawCheckpoint,
  type AssetDrawDeps,
  type AssetDrawInput,
  type AssetDrawOutput,
} from "./asset-draw.js";

const input: AssetDrawInput = {
  request: "draw a walking knight",
  projectId: "p1",
  assetId: "a1",
  userId: "u1",
  threadId: "t1",
  attachments: [],
  agentId: "pixel-draw:muse:medium",
  maxWorkers: 4,
  review: true,
  maxFrames: 12,
  maxPalette: 8,
};

const deps: AssetDrawDeps = {
  loadPlanContext: async () => ({
    projectName: "P",
    assetName: "A",
    assetId: "a1",
    paletteSize: 8,
    styleLines: ["outline"],
  }),
  loadWorkerContext: async () => ({
    promptData: {
      request: input.request,
      projectName: "P",
      assetName: "A",
      width: 32,
      height: 32,
      paletteSize: 8,
      styleLines: ["outline"],
      attachments: 0,
    },
  }),
  loadReviewContext: async () => "context",
};

const planJson = JSON.stringify({
  assetId: "a1",
  frames: [
    { name: "idle", intent: "stands", layers: ["body"] },
    { name: "walk", intent: "steps", layers: ["body", "shadow"] },
  ],
  palette: [],
  references: [],
  workers: [
    { key: "w1", frames: ["idle"] },
    { key: "w2", frames: ["walk"] },
  ],
  review: true,
});

type ChildRecord = {
  id: string;
  key: string;
  outcome?: { status: string; output?: unknown; error?: string };
};

function fakeCtx(options: {
  checkpoint: AssetDrawCheckpoint;
  children: ChildRecord[];
  attachments?: Array<{ mediaType: string; data: string }>;
}) {
  const spawns: Array<{
    key: string;
    agentId: string;
    prompt: unknown;
    continueFrom?: string;
  }> = [];
  const ctx = {
    id: "task-1",
    input: {
      ...input,
      ...(options.attachments ? { attachments: options.attachments } : {}),
    },
    checkpoint: options.checkpoint,
    signal: new AbortController().signal,
    spawnAgent: (
      key: string,
      child: { agentId: string; prompt: unknown; continueFrom?: string },
    ) => {
      spawns.push({ key, ...child });
      return `child-${key}`;
    },
    children: () =>
      options.children.map((child) => ({
        ...child,
        status: "completed",
        rootId: "task-1",
        depth: 1,
        sessionId: "s",
        name: "asset-draw",
        version: 1,
        submissionVersion: 1,
        submissionInput: {},
        input: {},
        checkpoint: {},
        signals: {},
      })),
    signalValue: () => undefined,
    agentRun: () => ({ id: "run" }),
    effect: async () => undefined,
  } as unknown as TaskContext<AssetDrawInput, AssetDrawCheckpoint>;
  return { ctx, spawns };
}

async function run(
  task: ReturnType<typeof createAssetDrawTask>,
  ctx: TaskContext<AssetDrawInput, AssetDrawCheckpoint>,
): Promise<TaskTransition<AssetDrawCheckpoint, AssetDrawOutput>> {
  return task.run(ctx);
}

describe("asset-draw plan phase", () => {
  it("carries the user's attachment images into the plan child's prompt", async () => {
    const withImages = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0 },
      children: [],
      attachments: [{ mediaType: "image/png", data: "AAAA" }],
    });
    await withImages.run(ctx);
    const prompt = spawns[0]?.prompt as { content?: Array<{ type: string }> };
    expect(Array.isArray(prompt?.content)).toBe(true);
    expect(prompt.content?.some((part) => part.type === "image")).toBe(true);
  });

  it("spawns the plan child on the first transition", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0 },
      children: [],
    });
    const transition = await run(task, ctx);
    expect(spawns[0]?.key).toBe("plan");
    expect(spawns[0]?.agentId).toBe(input.agentId);
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-plan"] },
    });
  });

  it("validates the plan child's output and spawns one worker per assignment with continueFrom", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "completed", output: planJson },
        },
      ],
    });
    const transition = await run(task, ctx);
    expect(spawns.map((spawn) => spawn.key)).toEqual(["w1", "w2"]);
    expect(spawns.every((spawn) => spawn.continueFrom === "plan")).toBe(true);
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-w1", "child-w2"] },
    });
  });

  it("re-plans once with the validation error, then fails with the cause", async () => {
    const task = createAssetDrawTask(deps);
    const bad = JSON.stringify({
      ...JSON.parse(planJson),
      workers: [{ key: "w1", frames: ["idle"] }],
    });
    const first = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        { id: "child-plan", key: "plan", outcome: { status: "completed", output: bad } },
      ],
    });
    const retry = await run(task, first.ctx);
    expect(first.spawns[0]?.key).toBe("plan-1");
    expect(String(first.spawns[0]?.prompt)).toContain(
      'Frame "walk" is not assigned to a worker.',
    );
    expect(retry).toMatchObject({ status: "waiting" });

    const second = fakeCtx({
      checkpoint: { phase: "plan", attempt: 1, planKey: "plan-1" },
      children: [
        {
          id: "child-plan-1",
          key: "plan-1",
          outcome: { status: "completed", output: bad },
        },
      ],
    });
    const failed = await run(task, second.ctx);
    expect(failed).toMatchObject({ status: "failed" });
    expect(String((failed as { error: string }).error)).toContain(
      "not assigned to a worker",
    );
  });

  it("fails when the plan child itself fails", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "failed", error: "boom" },
        },
      ],
    });
    expect(await run(task, ctx)).toMatchObject({
      status: "failed",
      error: "The plan phase did not complete: failed.",
    });
  });
});

describe("asset-draw execute phase", () => {
  it("completes without a review when every worker succeeded and neither Jev nor the plan wants one", async () => {
    const task = createAssetDrawTask(deps);
    const plan = { ...JSON.parse(planJson), review: false };
    const { ctx } = fakeCtx({
      checkpoint: {
        phase: "execute",
        plan,
        planKey: "plan",
        workerIds: ["child-w1", "child-w2"],
        workerKeys: ["w1", "w2"],
      },
      children: [
        { id: "child-w1", key: "w1", outcome: { status: "completed", output: "done" } },
        { id: "child-w2", key: "w2", outcome: { status: "completed", output: "done" } },
      ],
    });
    const noReview = { ...input, review: false };
    const withNoReview = { ...ctx, input: noReview } as typeof ctx;
    expect(await run(task, withNoReview)).toMatchObject({
      status: "completed",
      output: { rounds: 0, workers: 2 },
    });
  });

  it("honours the supervisor's own review request when Jev said no review", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const { ctx, spawns } = fakeCtx({
      checkpoint: {
        phase: "execute",
        plan,
        planKey: "plan",
        workerIds: ["child-w1", "child-w2"],
        workerKeys: ["w1", "w2"],
      },
      children: [
        { id: "child-w1", key: "w1", outcome: { status: "completed", output: "done" } },
        { id: "child-w2", key: "w2", outcome: { status: "completed", output: "done" } },
      ],
    });
    const withNoReview = { ...ctx, input: { ...input, review: false } } as typeof ctx;
    const transition = await run(task, withNoReview);
    expect(spawns.map((spawn) => spawn.key)).toContain("review-1");
    expect(transition).toMatchObject({ status: "waiting" });
  });
});

describe("asset-draw review phase", () => {
  it("spawns the review continuing the plan and finishes when it approves", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const first = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planKey: "plan",
        round: 1,
        fixIds: [],
      },
      children: [],
    });
    await run(task, first.ctx);
    expect(first.spawns[0]?.key).toBe("review-1");
    expect(first.spawns[0]?.continueFrom).toBe("plan");

    const approved = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planKey: "plan",
        round: 1,
        reviewKey: "review-1",
        fixIds: [],
      },
      children: [
        {
          id: "child-review-1",
          key: "review-1",
          outcome: { status: "completed", output: '{"ok":true}' },
        },
      ],
    });
    const done = await run(task, approved.ctx);
    expect(done).toMatchObject({
      status: "completed",
      output: { assetId: "a1", rounds: 1, workers: 2 },
    });
  });

  it("spawns fix workers continuing the review when it asks for fixes", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const { ctx, spawns } = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planKey: "plan",
        round: 1,
        reviewKey: "review-1",
        fixIds: [],
      },
      children: [
        {
          id: "child-review-1",
          key: "review-1",
          outcome: {
            status: "completed",
            output: '{"ok":false,"fixes":[{"frame":"walk","note":"outline"}]}',
          },
        },
      ],
    });
    const transition = await run(task, ctx);
    expect(spawns.map((spawn) => spawn.key)).toEqual(["fix-1-1"]);
    expect(spawns[0]?.continueFrom).toBe("review-1");
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-fix-1-1"] },
    });
  });
});

describe("parsePlanOutput", () => {
  it("names a JSON failure", () => {
    expect(parsePlanOutput("not json")).toEqual({
      ok: false,
      error: "The plan was not valid JSON.",
    });
  });
  it("names a schema failure", () => {
    const result = parsePlanOutput('{"frames":[]}');
    expect(result.ok).toBe(false);
  });
});

describe("buildPlanPrompt", () => {
  it("asks for JSON and carries a retry error when present", () => {
    expect(buildPlanPrompt(input)).toContain("JSON");
    expect(buildPlanPrompt(input, 'Frame "x" is not assigned to a worker.')).toContain(
      'Frame "x" is not assigned to a worker.',
    );
  });
  it("shows the exact schema so the answer conforms", () => {
    const prompt = buildPlanPrompt(input);
    for (const field of [
      '"workers"',
      '"appliesTo"',
      '"review"',
      '"layers"',
      '"palette"',
    ]) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain('"key":"w1"');
  });
  it("states the limits so the first plan already fits them", () => {
    const prompt = buildPlanPrompt(input);
    expect(prompt).toContain("at most 4 workers");
    expect(prompt).toContain("at most 12 frames");
    expect(prompt).toContain("at most 8 new palette colours");
  });
});
