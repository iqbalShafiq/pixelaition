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
  attachments: 0,
  agentIds: {
    plan: "pixel-draw:muse:medium",
    worker: "pixel-draw:worker:muse:medium",
    review: "pixel-draw:review:muse:medium",
    fix: "pixel-draw:fix:muse:medium",
  },
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

function fakeCtx(options: { checkpoint: AssetDrawCheckpoint; children: ChildRecord[] }) {
  const spawns: Array<{
    key: string;
    agentId: string;
    prompt: unknown;
    continueFrom?: string;
  }> = [];
  const ctx = {
    id: "task-1",
    input,
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
  it("spawns the plan child on the first transition", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0 },
      children: [],
    });
    const transition = await run(task, ctx);
    expect(spawns[0]?.key).toBe("plan");
    expect(spawns[0]?.agentId).toBe(input.agentIds.plan);
    expect(transition).toMatchObject({
      status: "waiting",
      wait: { type: "children", ids: ["child-plan"] },
    });
  });

  it("validates the plan child's output and spawns one worker per assignment with continueFrom", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planChildId: "child-plan" },
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
    expect(spawns.every((spawn) => spawn.continueFrom === "child-plan")).toBe(true);
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
      checkpoint: { phase: "plan", attempt: 0, planChildId: "child-plan" },
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
      checkpoint: { phase: "plan", attempt: 1, planChildId: "child-plan-1" },
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
      checkpoint: { phase: "plan", attempt: 0, planChildId: "child-plan" },
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

describe("asset-draw review phase", () => {
  it("spawns the review continuing the plan and finishes when it approves", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const first = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planChildId: "child-plan",
        round: 1,
        fixIds: [],
      },
      children: [],
    });
    await run(task, first.ctx);
    expect(first.spawns[0]?.key).toBe("review-1");
    expect(first.spawns[0]?.continueFrom).toBe("child-plan");

    const approved = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planChildId: "child-plan",
        round: 1,
        reviewChildId: "child-review-1",
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
        planChildId: "child-plan",
        round: 1,
        reviewChildId: "child-review-1",
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
    expect(spawns[0]?.continueFrom).toBe("child-review-1");
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
});
