import type { AgentPrompt } from "@anvia/core/agent";
import { defineTask, type TaskContext, type TaskTransition } from "@anvia/durable";
import { z } from "zod";
import { drawPlanSchema, validatePlan, type DrawPlan } from "./plan.js";
import {
  fixInstructions,
  planInstructions,
  reviewInstructions,
  workerInstructions,
} from "./roles.js";
import { buildWorkerPrompt, type WorkerPromptInput } from "./worker-prompt.js";

/**
 * One durable task per drawing request. Task code — never the model — decides
 * what spawns: a plan child (the supervisor), one worker child per assignment
 * continuing the plan's conversation, and a review child that reads every
 * frame and may order at most two fixes in at most two rounds.
 */

export const assetDrawInputSchema = z.object({
  request: z.string().min(1).max(4000),
  projectId: z.string().min(1).nullable(),
  assetId: z.string().min(1).nullable(),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  attachments: z
    .array(
      z.object({
        mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
        data: z.string().min(16),
      }),
    )
    .max(4),
  agentIds: z.object({
    plan: z.string().min(1),
    worker: z.string().min(1),
    review: z.string().min(1),
    fix: z.string().min(1),
  }),
  maxWorkers: z.number().int().min(1).max(4),
  review: z.boolean(),
  maxFrames: z.number().int().min(1).max(12),
  maxPalette: z.number().int().min(0).max(32),
});
export type AssetDrawInput = z.infer<typeof assetDrawInputSchema>;

export const assetDrawCheckpointSchema = z.discriminatedUnion("phase", [
  z.object({
    phase: z.literal("plan"),
    attempt: z.number().int().min(0).max(2),
    // The child's KEY, not its task id: `continueFrom` names a sibling key.
    planKey: z.string().optional(),
  }),
  z.object({
    phase: z.literal("execute"),
    plan: drawPlanSchema,
    planKey: z.string(),
    workerIds: z.array(z.string()),
  }),
  z.object({
    phase: z.literal("review"),
    plan: drawPlanSchema,
    planKey: z.string(),
    round: z.number().int().min(1).max(2),
    reviewKey: z.string().optional(),
    fixIds: z.array(z.string()),
  }),
]);
export type AssetDrawCheckpoint = z.infer<typeof assetDrawCheckpointSchema>;

export const assetDrawOutputSchema = z.object({
  assetId: z.string(),
  frames: z.array(z.string()),
  rounds: z.number().int().min(0).max(2),
  workers: z.number().int().min(1).max(4),
});
export type AssetDrawOutput = z.infer<typeof assetDrawOutputSchema>;

/**
 * Attachments ride as media parts the model sees directly; a prompt without
 * them stays a plain string, which keeps journals and replay simple.
 */
export function withAttachments(
  text: string,
  attachments: AssetDrawInput["attachments"],
): AgentPrompt {
  if (attachments.length === 0) return text;
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...attachments.map((attachment) => ({
        type: "image" as const,
        image: { type: "data" as const, data: attachment.data },
        mediaType: attachment.mediaType,
      })),
    ],
  };
}

/**
 * The exact shape the plan child must answer with. The model kept inventing
 * its own schema; showing the literal object removed the guesswork.
 */
export const PLAN_SCHEMA_EXAMPLE = [
  "Answer with exactly this JSON shape (no other fields):",
  '{"assetId":"<the asset id from read_project>",',
  '"frames":[{"name":"idle","intent":"what this frame shows","layers":["body","shadow"]}],',
  '"palette":[{"color":"#rrggbb","name":"glow"}],',
  '"references":[{"url":"https://...","note":"what to look at","appliesTo":"all"}],',
  '"workers":[{"key":"w1","frames":["idle"]}],',
  '"review":true}',
  "Every frame appears in exactly one worker; palette holds only the colours you added; references only when you actually searched.",
].join("\n");

export function buildPlanPrompt(input: AssetDrawInput, retryError?: string): string {
  return [
    input.request,
    planInstructions,
    PLAN_SCHEMA_EXAMPLE,
    retryError === undefined
      ? ""
      : `Your previous plan was rejected: ${retryError} Answer again with one corrected JSON object.`,
    "Answer with JSON only.",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function parsePlanOutput(
  output: string,
): { ok: true; plan: DrawPlan } | { ok: false; error: string } {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return { ok: false, error: "The plan was not valid JSON." };
  }
  const parsed = drawPlanSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      error: `The plan failed validation: ${issue?.path.join(".")} ${issue?.message}.`,
    };
  }
  return { ok: true, plan: parsed.data };
}

type Ctx = TaskContext<AssetDrawInput, AssetDrawCheckpoint>;
type Transition = TaskTransition<AssetDrawCheckpoint, AssetDrawOutput>;

function childOutput(
  ctx: Ctx,
  key: string,
): { status: string; output?: unknown; error?: string } | undefined {
  const child = ctx.children().find((record) => record.key === key);
  return child?.outcome;
}

/**
 * Steering messages arrive as fixed signal names (steer-1, steer-2, …); the
 * task scans until the first gap and hands them to the next supervisor pass.
 */
function deliveredSteers(ctx: Ctx): string {
  const messages: string[] = [];
  for (let index = 1; index <= 16; index += 1) {
    const value = ctx.signalValue(`steer-${index}`);
    if (value === undefined) break;
    const record = value as { message?: string; frames?: string[] };
    if (typeof record.message === "string") {
      messages.push(
        `The user steered${record.frames && record.frames.length > 0 ? ` (${record.frames.join(", ")})` : ""}: ${record.message}`,
      );
    }
  }
  return messages.length > 0 ? `User steering to honour: ${messages.join(" ")}` : "";
}

function planPhase(ctx: Ctx, deps: AssetDrawDeps): Promise<Transition> | Transition {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "plan" }>;
  if (checkpoint.planKey === undefined) {
    return (async () => {
      const context = await deps.loadPlanContext(ctx.input);
      const key = checkpoint.attempt === 0 ? "plan" : `plan-${checkpoint.attempt}`;
      const id = ctx.spawnAgent(key, {
        agentId: ctx.input.agentIds.plan,
        prompt: withAttachments(
          `${buildPlanPrompt(ctx.input)}\nProject: ${context.projectName}. Asset: ${context.assetName}. Palette: ${context.paletteSize} colours.`,
          ctx.input.attachments,
        ),
      });
      return {
        status: "waiting",
        checkpoint: { ...checkpoint, planKey: key },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    })();
  }
  const outcome = childOutput(ctx, checkpoint.planKey);
  if (outcome?.status !== "completed" || typeof outcome.output !== "string") {
    return {
      status: "failed",
      error: `The plan phase did not complete: ${outcome?.status ?? "unknown"}.`,
    };
  }
  const parsed = parsePlanOutput(outcome.output);
  const checked = parsed.ok
    ? validatePlan(parsed.plan, {
        maxWorkers: ctx.input.maxWorkers,
        maxFrames: ctx.input.maxFrames,
        maxPalette: ctx.input.maxPalette,
      })
    : { ok: false as const, error: parsed.error };
  if (!checked.ok) {
    // One bounded re-plan: attempt 0 may retry once with the named error.
    if (checkpoint.attempt >= 1) {
      return { status: "failed", error: `The plan was invalid twice: ${checked.error}` };
    }
    const id = ctx.spawnAgent(`plan-${checkpoint.attempt + 1}`, {
      agentId: ctx.input.agentIds.plan,
      prompt: buildPlanPrompt(ctx.input, checked.error),
    });
    return {
      status: "waiting",
      checkpoint: {
        phase: "plan",
        attempt: checkpoint.attempt + 1,
        planKey: `plan-${checkpoint.attempt + 1}`,
      },
      wait: { type: "children", ids: [id], policy: "allSettled" },
    };
  }
  const plan = parsed.ok ? parsed.plan : undefined;
  if (plan === undefined) {
    return { status: "failed", error: "The plan was invalid twice: unknown." };
  }
  return (async () => {
    const workerIds: string[] = [];
    for (const worker of plan.workers) {
      const context = await deps.loadWorkerContext(ctx.input, plan, worker.key);
      const ownedFrames = plan.frames.filter((frame) =>
        worker.frames.includes(frame.name),
      );
      const readOnly = plan.frames
        .filter((frame) => !worker.frames.includes(frame.name))
        .map((frame) => frame.name);
      const references = plan.references
        .filter(
          (reference) =>
            reference.appliesTo === "all" ||
            reference.appliesTo.some((name) => worker.frames.includes(name)),
        )
        .map((reference) => ({ url: reference.url, note: reference.note }));
      workerIds.push(
        ctx.spawnAgent(worker.key, {
          agentId: ctx.input.agentIds.worker,
          prompt: withAttachments(
            [
              workerInstructions,
              buildWorkerPrompt({
                ...context.promptData,
                attachments: ctx.input.attachments.length,
                ownedFrames,
                readOnlyFrames: readOnly,
                references,
              }),
            ].join("\n\n"),
            ctx.input.attachments,
          ),
          continueFrom: checkpoint.planKey,
        }),
      );
    }
    return {
      status: "waiting",
      checkpoint: {
        phase: "execute",
        plan,
        planKey: checkpoint.planKey as string,
        workerIds,
      },
      wait: { type: "children", ids: workerIds, policy: "allSettled" },
    };
  })();
}

function executePhase(ctx: Ctx, deps: AssetDrawDeps): Promise<Transition> | Transition {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "execute" }>;
  const failed = checkpoint.workerIds.filter(
    (id) => childOutput(ctx, id)?.status !== "completed",
  );
  if (!ctx.input.review && failed.length === 0) {
    return {
      status: "completed",
      output: {
        assetId: checkpoint.plan.assetId,
        frames: checkpoint.plan.frames.map((frame) => frame.name),
        rounds: 0,
        workers: checkpoint.plan.workers.length,
      },
    };
  }
  return (async () => {
    const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
    const id = ctx.spawnAgent("review-1", {
      agentId: ctx.input.agentIds.review,
      prompt: [
        reviewInstructions,
        context,
        failed.length > 0 ? `Workers that did not finish: ${failed.join(", ")}.` : "",
        deliveredSteers(ctx),
      ]
        .filter((line) => line.length > 0)
        .join("\n\n"),
      continueFrom: checkpoint.planKey,
    });
    return {
      status: "waiting",
      checkpoint: {
        phase: "review",
        plan: checkpoint.plan,
        planKey: checkpoint.planKey,
        round: 1,
        reviewKey: "review-1",
        fixIds: [],
      },
      wait: { type: "children", ids: [id], policy: "allSettled" },
    };
  })();
}

function reviewPhase(ctx: Ctx, deps: AssetDrawDeps): Promise<Transition> | Transition {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "review" }>;
  const finish = (rounds: number): Transition => ({
    status: "completed",
    output: {
      assetId: checkpoint.plan.assetId,
      frames: checkpoint.plan.frames.map((frame) => frame.name),
      rounds,
      workers: checkpoint.plan.workers.length,
    },
  });
  if (checkpoint.reviewKey === undefined) {
    return (async () => {
      const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
      const id = ctx.spawnAgent(`review-${checkpoint.round}`, {
        agentId: ctx.input.agentIds.review,
        prompt: [reviewInstructions, context, deliveredSteers(ctx)]
          .filter((line) => line.length > 0)
          .join("\n\n"),
        continueFrom: checkpoint.planKey,
      });
      return {
        status: "waiting",
        checkpoint: { ...checkpoint, reviewKey: `review-${checkpoint.round}` },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    })();
  }
  if (checkpoint.fixIds.length > 0) {
    // The fixes finished; either start the second review round or stop.
    if (checkpoint.round >= 2) return finish(checkpoint.round);
    return (async () => {
      const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
      const id = ctx.spawnAgent(`review-${checkpoint.round + 1}`, {
        agentId: ctx.input.agentIds.review,
        prompt: [reviewInstructions, context, deliveredSteers(ctx)]
          .filter((line) => line.length > 0)
          .join("\n\n"),
        continueFrom: checkpoint.planKey,
      });
      return {
        status: "waiting",
        checkpoint: {
          phase: "review",
          plan: checkpoint.plan,
          planKey: checkpoint.planKey,
          round: checkpoint.round + 1,
          reviewKey: `review-${checkpoint.round + 1}`,
          fixIds: [],
        },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    })();
  }
  const outcome = childOutput(ctx, checkpoint.reviewKey);
  if (outcome?.status !== "completed" || typeof outcome.output !== "string") {
    return {
      status: "failed",
      error: `The review phase did not complete: ${outcome?.status ?? "unknown"}.`,
    };
  }
  let verdict: { ok?: boolean; fixes?: Array<{ frame: string; note: string }> };
  try {
    verdict = JSON.parse(outcome.output) as typeof verdict;
  } catch {
    return { status: "failed", error: "The review answered with invalid JSON." };
  }
  if (verdict.ok === true || checkpoint.round >= 2) return finish(checkpoint.round);
  const fixes = (verdict.fixes ?? [])
    .slice(0, 2)
    .filter((fix) => checkpoint.plan.frames.some((frame) => frame.name === fix.frame));
  if (fixes.length === 0) return finish(checkpoint.round);
  const fixIds = fixes.map((fix, index) => {
    const frame = checkpoint.plan.frames.find(
      (candidate) => candidate.name === fix.frame,
    );
    return ctx.spawnAgent(`fix-${checkpoint.round}-${index + 1}`, {
      agentId: ctx.input.agentIds.fix,
      prompt: [
        fixInstructions,
        `Fix "${fix.frame}": ${fix.note}`,
        `Intent: ${frame?.intent ?? ""}.`,
      ].join("\n\n"),
      continueFrom: checkpoint.reviewKey,
    });
  });
  return {
    status: "waiting",
    checkpoint: { ...checkpoint, fixIds },
    wait: { type: "children", ids: fixIds, policy: "allSettled" },
  };
}

export type PlanContext = {
  projectName: string;
  assetName: string;
  assetId: string;
  paletteSize: number;
  styleLines: string[];
};
export type WorkerContext = {
  promptData: Omit<WorkerPromptInput, "ownedFrames" | "readOnlyFrames" | "references">;
};
export type AssetDrawDeps = {
  loadPlanContext(input: AssetDrawInput): Promise<PlanContext>;
  loadWorkerContext(
    input: AssetDrawInput,
    plan: DrawPlan,
    workerKey: string,
  ): Promise<WorkerContext>;
  loadReviewContext(input: AssetDrawInput, plan: DrawPlan): Promise<string>;
};

export function createAssetDrawTask(deps: AssetDrawDeps) {
  return defineTask({
    name: "asset-draw",
    version: 1,
    input: assetDrawInputSchema,
    checkpoint: assetDrawCheckpointSchema,
    output: assetDrawOutputSchema,
    initial: () => ({ phase: "plan" as const, attempt: 0 }),
    run: async (ctx) => {
      if (ctx.checkpoint.phase === "plan") return planPhase(ctx, deps);
      if (ctx.checkpoint.phase === "execute") return executePhase(ctx, deps);
      return reviewPhase(ctx, deps);
    },
  });
}
