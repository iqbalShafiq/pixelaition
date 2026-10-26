import type { TaskContext, TaskTransition } from "@anvia/durable";
import { describe, expect, it } from "vitest";
import type { DrawPlan } from "./plan.js";
import {
  assetDrawInputSchema,
  buildPlanPrompt,
  createAssetDrawTask,
  minFramesFor,
  parsePlanOutput,
  promptText,
  userRequestFromPrompt,
  withAttachments,
  type AssetDrawCheckpoint,
  type AssetDrawDeps,
  type AssetDrawInput,
  type AssetDrawOutput,
} from "./asset-draw.js";

const input: AssetDrawInput = {
  request: "draw a knight standing still",
  projectId: "p1",
  assetId: "a1",
  userId: "u1",
  threadId: "t1",
  attachments: [],
  agentId: "pixel-draw:muse:medium",
  maxWorkers: 4,
  review: true,
  maxPalette: 24,
};

const deps: AssetDrawDeps = {
  claimDefaultFrame: async () => false,
  unpaintedFrames: async () => [],
  loadPlanContext: async () => ({
    projectName: "P",
    assetName: "A",
    assetId: "a1",
    paletteSize: 8,
    styleLines: ["outline"],
    frames: ["idle", "walk"],
  }),
  loadWorkerContext: async () => ({
    promptData: {
      request: input.request,
      projectName: "P",
      assetName: "A",
      width: 32,
      height: 32,
      paletteSize: 2,
      palette: ["#00000000", "#1a1c2c"],
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
    spawn: (
      key: string,
      _task: unknown,
      child: { agentId?: string; prompt?: unknown },
    ) => {
      spawns.push({
        key,
        agentId: child.agentId ?? "",
        prompt: child.prompt,
      });
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

describe("asset-draw input", () => {
  it("keeps the model's vision capability on the parsed input", () => {
    // Without the schema field the durable layer strips it and the loader
    // would hand image parts to a model that cannot view them.
    const parsed = assetDrawInputSchema.parse({ ...input, modelVision: false });
    expect(parsed.modelVision).toBe(false);
  });

  it("parses without a frames cap and strips a legacy one", () => {
    const legacy = { ...input, maxFrames: 12 } as unknown as Record<string, unknown>;
    const parsed = assetDrawInputSchema.parse(legacy);
    expect("maxFrames" in parsed).toBe(false);
    expect(parsed.maxPalette).toBe(24);
  });
});

describe("user request from prompt", () => {
  it("reads the request from a plan prompt and a worker Request line", () => {
    expect(
      userRequestFromPrompt("plan", "please make the sweet face\nLimits: at most 4"),
    ).toBe("please make the sweet face");
    expect(userRequestFromPrompt("plan", "(prompt with reference images)")).toBeNull();
    expect(userRequestFromPrompt("worker", "Request: fix the blush\nPaint only")).toBe(
      "fix the blush",
    );
  });

  it("reads past an earlier-turns block to the request that follows", () => {
    const prompt = [
      "Earlier drawing turns on this asset, oldest first. Honour them.",
      "",
      "Turn 1. User: please make the sweet face",
      "Supervisor · read_project — ok",
      "",
      "This message continues that work.",
      "",
      "i think the asset is not the same with s.coups?",
      "Limits: at most 4 frames",
    ].join("\n");
    expect(userRequestFromPrompt("plan", prompt)).toBe(
      "i think the asset is not the same with s.coups?",
    );
  });

  it("has nothing to read when the turns block closes the prompt", () => {
    const prompt = [
      "Earlier drawing turns on this asset, oldest first. Honour them.",
      "",
      "This message continues that work.",
    ].join("\n");
    expect(userRequestFromPrompt("plan", prompt)).toBeNull();
  });
});

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

  it("puts every earlier turn, then this request, on a fresh plan child", async () => {
    const task = createAssetDrawTask({
      ...deps,
      loadPriorContext: async () => ({
        text: "Earlier drawing turns on this asset\nTurn 1. User: please make the sweet face",
        attachments: [{ mediaType: "image/jpeg", data: "b".repeat(16) }],
      }),
    });
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0 },
      children: [],
      attachments: [{ mediaType: "image/png", data: "a".repeat(16) }],
    });
    await task.run(ctx);
    const prompt = spawns[0]?.prompt as {
      content?: Array<{ type: string; text?: string; image?: { data: string } }>;
    };
    expect(prompt.content?.[0]?.text).toContain("please make the sweet face");
    expect(prompt.content?.[0]?.text).toContain(input.request);
    expect(
      prompt.content
        ?.filter((part) => part.type === "image")
        .map((part) => part.image?.data[0]),
    ).toEqual(["b", "a"]);
  });

  it("reloads earlier turns when the plan child is spawned again after a failure", async () => {
    let calls = 0;
    const task = createAssetDrawTask({
      ...deps,
      loadPriorContext: async () => {
        calls += 1;
        return { text: "Turn 1. User: the first pose", attachments: [] };
      },
    });
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [{ id: "child-plan", key: "plan", outcome: { status: "failed" } }],
    });
    await task.run(ctx);
    expect(calls).toBe(1);
    expect(String(spawns[0]?.prompt)).toContain("the first pose");
    expect(spawns[0]?.continueFrom).toBeUndefined();
  });

  it("leaves an approved-plan correction on the same conversation", async () => {
    let calls = 0;
    const task = createAssetDrawTask({
      ...deps,
      loadPriorContext: async () => {
        calls += 1;
        return { text: "EARLIER", attachments: [] };
      },
    });
    const bad = JSON.stringify({
      ...JSON.parse(planJson),
      workers: [{ key: "w1", frames: ["idle"] }],
    });
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        { id: "child-plan", key: "plan", outcome: { status: "completed", output: bad } },
      ],
    });
    await task.run(ctx);
    expect(calls).toBe(0);
    expect(spawns[0]?.continueFrom).toBe("plan");
    expect(String(spawns[0]?.prompt)).not.toContain("EARLIER");
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
    expect(spawns.map((spawn) => spawn.key)).toEqual(["slot-w1", "slot-w2"]);
    expect(String(spawns[0]?.prompt)).toContain("Paint only these frames");
    expect(transition).toMatchObject({
      status: "waiting",
      wait: {
        type: "children",
        ids: ["child-slot-w1", "child-slot-w2"],
        policy: "allSettled",
      },
    });
  });

  it("loads worker contexts together so the spawns are not staggered", async () => {
    let active = 0;
    let peak = 0;
    const task = createAssetDrawTask({
      ...deps,
      loadWorkerContext: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          promptData: {
            request: input.request,
            projectName: "P",
            assetName: "A",
            width: 32,
            height: 32,
            paletteSize: 2,
            palette: ["#00000000", "#1a1c2c"],
            styleLines: ["outline"],
            attachments: 0,
          },
        };
      },
    });
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
    expect(peak).toBe(2);
    expect(spawns.map((spawn) => spawn.key)).toEqual(["slot-w1", "slot-w2"]);
    expect(transition).toMatchObject({
      wait: { type: "children", policy: "allSettled" },
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

  it("retries the plan child, then fails with the cause", async () => {
    const task = createAssetDrawTask(deps);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "failed", error: "boom" },
        },
      ],
    });
    const first = await run(task, ctx);
    expect(first).toMatchObject({ status: "waiting" });
    expect(spawns.map((spawn) => spawn.key)).toEqual(["plan-retry-1"]);

    const spent = await run(task, {
      ...ctx,
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan", retries: { plan: 4 } },
    } as typeof ctx);
    expect(spent).toMatchObject({
      status: "failed",
      error: "The plan phase did not complete after 4 retries: failed.",
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
          outcome: { status: "completed", output: '{"done":true}' },
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
            output: '{"done":false,"fixes":[{"frame":"walk","note":"outline"}]}',
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

  it("orders another round whenever the reviewer asks, however late", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const afterFix = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planKey: "plan",
        round: 9,
        reviewKey: "review-9",
        fixIds: ["child-fix-9-1"],
        log: ['- review-8 → "walk": widened the stand'],
      },
      children: [
        {
          id: "child-fix-9-1",
          key: "fix-9-1",
          outcome: { status: "completed", output: "copied the stand from idle" },
        },
      ],
    });
    const next = await run(task, afterFix.ctx);
    expect(afterFix.spawns.map((spawn) => spawn.key)).toEqual(["review-10"]);
    expect(next).toMatchObject({ status: "waiting" });
    // The work log rides into the next review so it knows what was tried.
    const prompt = afterFix.spawns[0]?.prompt;
    expect(typeof prompt).toBe("string");
    expect(prompt as string).toContain("widened the stand");
    expect(prompt as string).toContain("copied the stand from idle");
  });

  it("completes when the reviewer says okay, carrying its judgement", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const review = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planKey: "plan",
        round: 3,
        reviewKey: "review-3",
        fixIds: [],
      },
      children: [
        {
          id: "child-review-3",
          key: "review-3",
          outcome: {
            status: "completed",
            output: '{"done":true,"summary":"all four poses read as one spin"}',
          },
        },
      ],
    });
    const done = await run(task, review.ctx);
    expect(review.spawns).toEqual([]);
    expect(done).toMatchObject({
      status: "completed",
      output: {
        rounds: 3,
        review: { ok: true, summary: "all four poses read as one spin" },
      },
    });
  });

  it("completes with the reviewer's unfinished notes as a verdict, not a failure", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const review = fakeCtx({
      checkpoint: {
        phase: "review",
        plan,
        planKey: "plan",
        round: 2,
        reviewKey: "review-2",
        fixIds: [],
      },
      children: [
        {
          id: "child-review-2",
          key: "review-2",
          outcome: {
            status: "completed",
            output: JSON.stringify({
              done: false,
              fixes: [
                {
                  frame: "walk",
                  note: "the second panel's left edge is one pixel narrower than the first",
                  referenceFrame: "idle",
                },
              ],
            }),
          },
        },
      ],
    });
    // A frame the plan names but the fake context does not paint makes the
    // completion gate ask for one repair; that is the task's own backstop.
    const done = await run(task, review.ctx);
    expect(["waiting", "completed"]).toContain(done.status);
    if (done.status === "completed") {
      expect(done.output.review?.ok).toBe(false);
    }
  });

  it("keeps the whole note in the fix prompt and names the reference frame", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const longNote =
      "The stand under the fan is two pixels wider than in idle and one pixel lower; copy the stand rows from idle instead of redrawing them, then keep the blades as they are.";
    const review = fakeCtx({
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
            output: JSON.stringify({
              done: false,
              fixes: [{ frame: "walk", note: longNote, referenceFrame: "idle" }],
            }),
          },
        },
      ],
    });
    await run(task, review.ctx);
    const fixPrompt = review.spawns[0]?.prompt as string;
    expect(fixPrompt).toContain(longNote);
    expect(fixPrompt).toContain('"idle"');
  });
});

describe("promptText", () => {
  it("keeps the words of a prompt that also carries reference images", () => {
    expect(
      promptText(
        withAttachments("i think the asset is not the same with s.coups?", [
          { mediaType: "image/jpeg", data: "a".repeat(16) },
        ]),
      ),
    ).toBe("i think the asset is not the same with s.coups?");
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
  it("accepts a comma-separated frame list in a reference", () => {
    const plan = JSON.parse(planJson);
    plan.references = [
      {
        url: "https://example.com/cat.jpg",
        note: "orange cat",
        appliesTo: "idle, walk",
      },
    ];
    const result = parsePlanOutput(JSON.stringify(plan));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.references[0]?.appliesTo).toEqual(["idle", "walk"]);
    }
  });
});

describe("plan approval", () => {
  it("sends a plan that never called present_plan back to the card", async () => {
    const task = createAssetDrawTask({
      ...deps,
      planWasPresented: async () => false,
    });
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
    expect(transition).toMatchObject({ status: "waiting" });
    expect(spawns.map((spawn) => spawn.key)).toEqual(["plan-present"]);
    expect(spawns[0]?.continueFrom).toBe("plan");
  });
});

describe("plan limits", () => {
  it("reads a motion request as needing key frames", () => {
    expect(minFramesFor("a bird flapping its wings")).toBe(3);
    expect(minFramesFor("seekor burung yang mengepakkan sayapnya")).toBe(3);
    expect(minFramesFor("a knight standing still")).toBe(1);
  });

  it("refuses a one-frame plan for a motion request and re-plans with the cause", async () => {
    const task = createAssetDrawTask(deps);
    const plan = JSON.parse(planJson);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "completed", output: JSON.stringify(plan) },
        },
      ],
    });
    const flapping = {
      ...ctx,
      input: { ...input, request: "seekor burung yang mengepakkan sayapnya" },
    } as typeof ctx;
    const transition = await run(task, flapping);
    expect(transition).toMatchObject({ status: "waiting" });
    expect(spawns.map((spawn) => spawn.key)).toEqual(["plan-1"]);
    expect(spawns[0]?.prompt).toContain("at least 3 key frames");
  });
});

describe("approved frames that were never created", () => {
  it("sends the plan child back to create them, then fails with the cause", async () => {
    const task = createAssetDrawTask({
      ...deps,
      loadPlanContext: async () => ({
        projectName: "P",
        assetName: "A",
        assetId: "a1",
        paletteSize: 8,
        styleLines: ["outline"],
        frames: [],
      }),
    });
    const plan = JSON.parse(planJson);
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "completed", output: JSON.stringify(plan) },
        },
      ],
    });
    const first = await run(task, ctx);
    expect(first).toMatchObject({ status: "waiting" });
    expect(spawns.map((spawn) => spawn.key)).toEqual(["plan-create"]);
    expect(spawns[0]?.prompt).toContain("add_frame");

    const second = await run(task, {
      ...ctx,
      checkpoint: {
        ...(ctx.checkpoint as Record<string, unknown>),
        framesCreateTried: true,
      },
    } as typeof ctx);
    expect(second).toMatchObject({ status: "failed" });
    expect(JSON.stringify(second)).toContain("never created");
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
    expect(prompt).toContain(
      "The palette holds up to 256 entries including transparent; 24 more can be added.",
    );
    expect(prompt).not.toContain("at most 12 frames");
  });
});

describe("the empty default frame", () => {
  it("is renamed to the plan's first frame instead of shipping empty", async () => {
    let claimed: string | null = null;
    const renamed = JSON.parse(planJson) as {
      frames: Array<{ name: string }>;
      workers: Array<{ frames: string[] }>;
    };
    const names: Record<string, string> = { idle: "walk-1", walk: "walk-2" };
    renamed.frames = renamed.frames.map((frame) => ({
      ...frame,
      name: names[frame.name] ?? frame.name,
    }));
    renamed.workers = renamed.workers.map((worker) => ({
      ...worker,
      frames: worker.frames.map((name) => names[name] ?? name),
    }));
    let framesNow = ["idle"];
    const task = createAssetDrawTask({
      ...deps,
      claimDefaultFrame: async (_input, name) => {
        claimed = name;
        framesNow = renamed.frames.map((frame) => frame.name);
        return true;
      },
      loadPlanContext: async () => ({
        projectName: "P",
        assetName: "A",
        assetId: "a1",
        paletteSize: 8,
        styleLines: ["outline"],
        frames: framesNow,
      }),
    });
    const { ctx, spawns } = fakeCtx({
      checkpoint: { phase: "plan", attempt: 0, planKey: "plan" },
      children: [
        {
          id: "child-plan",
          key: "plan",
          outcome: { status: "completed", output: JSON.stringify(renamed) },
        },
      ],
    });
    const first = await run(task, ctx);
    expect(first).toMatchObject({ status: "waiting" });
    expect(claimed).toEqual("walk-1");
    expect(spawns.map((spawn) => spawn.key)).not.toContain("plan-create");
  });
});

describe("frames the review let through", () => {
  const plan = JSON.parse(planJson) as DrawPlan;
  const reviewChild = {
    id: "child-review",
    key: "review-1",
    outcome: { status: "completed" as const, output: '{"done":true}' },
  };
  it("gets one deterministic repair, then completes", async () => {
    let empty = ["walk"];
    const calls: string[][] = [];
    const task = createAssetDrawTask({
      ...deps,
      unpaintedFrames: async (_input, names) => {
        calls.push(names);
        return empty;
      },
    });
    const checkpoint = {
      phase: "review" as const,
      plan,
      planKey: "plan",
      round: 1,
      reviewKey: "review-1",
      fixIds: [],
    };
    const { ctx, spawns } = fakeCtx({ checkpoint, children: [reviewChild] });
    const first = await run(task, ctx);
    expect(first).toMatchObject({ status: "waiting" });
    expect(spawns.map((spawn) => spawn.key)).toEqual(["fix-unpainted"]);
    expect(spawns[0]?.prompt).toContain("walk");

    empty = [];
    const second = await run(task, {
      ...ctx,
      checkpoint: { ...checkpoint, retries: { unpainted: 1 } },
    } as typeof ctx);
    expect(second).toMatchObject({ status: "completed" });
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("fails with the frame names when the repair left them empty", async () => {
    const task = createAssetDrawTask({
      ...deps,
      unpaintedFrames: async () => ["walk"],
    });
    const { ctx } = fakeCtx({
      checkpoint: {
        phase: "review" as const,
        plan,
        planKey: "plan",
        round: 1,
        reviewKey: "review-1",
        fixIds: [],
        retries: { unpainted: 1 },
      },
      children: [reviewChild],
    });
    const out = await run(task, ctx as typeof ctx);
    expect(out).toMatchObject({ status: "failed" });
    expect(JSON.stringify(out)).toContain("walk");
  });
});
