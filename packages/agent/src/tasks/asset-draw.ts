import type { AgentPrompt } from "@anvia/core/agent";
import { defineTask, type TaskContext, type TaskTransition } from "@anvia/durable";
import { z } from "zod";
import { MAX_COLORS } from "@pixelaition/pixel";
import {
  drawPlanSchema,
  parseReviewVerdict,
  validatePlan,
  type DrawPlan,
  type ReviewFix,
} from "./plan.js";
import {
  fixInstructions,
  planInstructions,
  reviewInstructions,
  workerInstructions,
} from "./roles.js";
import { buildWorkerPrompt, type WorkerPromptInput } from "./worker-prompt.js";
import { workerAttemptTask } from "./worker-attempt.js";

/**
 * One durable task per drawing request. Task code decides what spawns — a plan
 * child (the supervisor), one worker child per assignment, and a review child
 * that reads every frame and answers with a verdict — but not how many review
 * rounds are enough: the reviewer says `ok` when the frames meet the request,
 * and the conversation carries the history of every round. A round budget in
 * code would stop the work on a count instead of on judgement.
 */

export const assetDrawInputSchema = z.object({
  /** The user's own words. Full: a turn is what the user typed, not a summary of it. */
  request: z.string().min(1),
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
  // One agent serves every role: `continueFrom` only continues a child of the
  // same agent, and the role gate enforces what each child may call.
  agentId: z.string().min(1),
  maxWorkers: z.number().int().min(1).max(4),
  review: z.boolean(),
  maxPalette: z.number().int().min(0).max(255),
  /** The frame the user had open, so an edit names the real frame, not a stale summary. */
  selectedFrame: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
      width: z.number().int().min(1),
      height: z.number().int().min(1),
    })
    .optional(),
  /**
   * The public run_tasks id. Prior-turn loading uses it to skip this request.
   * Older tasks omit it; the loader then skips the newest live row instead.
   */
  taskId: z.string().min(1).optional(),
  /**
   * Whether the chosen model can view images. Prior-turn loading drops the
   * earlier reference images and says so when this is false; omitted keeps
   * them, which is the right answer for older tasks and vision targets.
   */
  modelVision: z.boolean().optional(),
});
export type AssetDrawInput = z.infer<typeof assetDrawInputSchema>;

/** Bookkeeping that must survive a restart: bounded retries per child role. */
const PHASE_EXTRAS = {
  retries: z.record(z.string(), z.number().int().min(0).max(3)).optional(),
  framesCreateTried: z.boolean().optional(),
  framesCreateKey: z.string().optional(),
};

export const assetDrawCheckpointSchema = z.discriminatedUnion("phase", [
  z.object({
    ...PHASE_EXTRAS,
    phase: z.literal("plan"),
    attempt: z.number().int().min(0).max(2),
    // The child's KEY, not its task id: `continueFrom` names a sibling key.
    planKey: z.string().optional(),
  }),
  z.object({
    ...PHASE_EXTRAS,
    phase: z.literal("execute"),
    plan: drawPlanSchema,
    planKey: z.string(),
    workerIds: z.array(z.string()),
    // The join needs spawn ids; outcome checks need the stable keys.
    workerKeys: z.array(z.string()).optional(),
    /**
     * Each worker is its own task and retries there. Older checkpoints spawned
     * the agents directly and retry them in this phase.
     */
    workerSlots: z.boolean().optional(),
  }),
  z.object({
    ...PHASE_EXTRAS,
    phase: z.literal("review"),
    plan: drawPlanSchema,
    planKey: z.string(),
    round: z.number().int().min(1),
    reviewKey: z.string().optional(),
    fixIds: z.array(z.string()),
    /**
     * The work log across rounds: what each review ordered and what its fix
     * children reported. Every round's prompt carries it, so a reviewer sees
     * that an instruction was already tried and a fixer sees how the last
     * attempt went — without depending on the model remembering.
     */
    log: z.array(z.string()).optional(),
  }),
]);
export type AssetDrawCheckpoint = z.infer<typeof assetDrawCheckpointSchema>;

/**
 * A fix child's own budget: a frame, its layers, one save, and a sentence.
 * Without it the child inherits the agent's long painting loop and can grind
 * past the work it was ordered to do.
 */
export const FIX_MODEL_TURNS = 16;
/**
 * Creating N frames and the palette takes N+1 model calls at least. The
 * runtime reports a turn limit as a failed child (it does not hand back the
 * partial conversation), so the cap carries slack for a re-read or a retry:
 * a create pass that needs 4 turns was refused by a cap of 4.
 */
export const FRAME_CREATION_TURNS = 12;

/** A child that died on a provider hiccup gets a fresh attempt, bounded. */
const CHILD_RETRIES = 4;
/** A plan call whose stream the provider mangled is worth attempting again. */
const PLAN_RETRIES = 4;

function retriesFor(
  checkpoint: { retries?: Record<string, number> },
  key: string,
): number {
  return checkpoint.retries?.[key] ?? 0;
}

function withRetry(
  checkpoint: { retries?: Record<string, number> },
  key: string,
): Record<string, number> {
  return { ...checkpoint.retries, [key]: retriesFor(checkpoint, key) + 1 };
}

export const assetDrawOutputSchema = z.object({
  assetId: z.string(),
  frames: z.array(z.string()),
  rounds: z.number().int().min(0),
  workers: z.number().int().min(1).max(4),
  /**
   * The reviewer's closing judgement. A `false` here is an artistic verdict —
   * the frames were finished and the reviewer still saw room — and never a
   * system failure; a run that could not finish fails with an error instead.
   */
  review: z
    .object({
      ok: z.boolean(),
      summary: z.string().optional(),
      notes: z.array(z.string()),
    })
    .optional(),
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

/** What promptText returns when a prompt held only image parts. */
export const PROMPT_PLACEHOLDER = "(prompt with reference images)";

/** The words of a prompt, without its image parts. */
export function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (prompt !== null && typeof prompt === "object" && "content" in prompt) {
    const content = (prompt as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .flatMap((part) => {
          if (part === null || typeof part !== "object") return [];
          const record = part as { type?: unknown; text?: unknown };
          return record.type === "text" && typeof record.text === "string"
            ? [record.text]
            : [];
        })
        .join("\n")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return PROMPT_PLACEHOLDER;
}

/** The line the worker's earlier-turns block always closes with. */
const PRIOR_BLOCK_END = "This message continues that work.";

/**
 * The line a person typed, from a stored child prompt. Worker prompts start
 * with `Request:`; a plan prompt starts with the request itself — unless an
 * earlier-turns block precedes it, in which case the request follows the
 * block's closing line.
 */
export function userRequestFromPrompt(
  role: string | null,
  prompt: string | null,
): string | null {
  if (prompt === null) return null;
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed === PROMPT_PLACEHOLDER) return null;
  const lines = trimmed.split("\n");
  for (const line of lines) {
    if (!line.startsWith("Request: ")) continue;
    const text = line.slice("Request: ".length).trim();
    if (text.length > 0) return text;
  }
  if (role !== "plan") return null;
  const end = lines.findIndex((line) => line.trim() === PRIOR_BLOCK_END);
  const first = lines
    .slice(end + 1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (first === undefined || first === PROMPT_PLACEHOLDER) return null;
  if (
    first.startsWith("The user ") ||
    first.startsWith("Limits:") ||
    first.startsWith("Answer with")
  ) {
    return null;
  }
  return first;
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

/** A request that describes the subject acting needs key frames, not one pose. */
const MOTION_REQUEST =
  /(mengepak|kepak|flap|melompat|lompat|jump|berlari|lari|run|berjalan|jalan|walk|beranimasi|animasi|animation|looping|loop)/i;

export function minFramesFor(request: string): number {
  return MOTION_REQUEST.test(request) ? 3 : 1;
}

export function buildPlanPrompt(input: AssetDrawInput, retryError?: string): string {
  return [
    input.request,
    planInstructions,
    ...(input.selectedFrame
      ? [
          `The user has this frame open: ${input.selectedFrame.name} (${input.selectedFrame.id}), ${input.selectedFrame.width}×${input.selectedFrame.height}. For an edit to this frame, plan exactly this frame and its existing layers; do not create a replacement frame or rename it.`,
        ]
      : []),
    `Limits: at most ${input.maxWorkers} workers. The palette holds up to ${
      MAX_COLORS + 1
    } entries including transparent; ${input.maxPalette} more can be added.` +
      (minFramesFor(input.request) > 1
        ? ` This request describes movement: plan at least ${minFramesFor(input.request)} key frames, one per key pose.`
        : ""),
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
    const record = value as { message?: string; frames?: string[]; delivered?: boolean };
    if (typeof record.message === "string") {
      messages.push(
        `The user steered${record.frames && record.frames.length > 0 ? ` (${record.frames.join(", ")})` : ""}: ${record.message}${record.delivered === true ? " (already relayed to the worker mid-run; verify it landed)" : ""}`,
      );
    }
  }
  return messages.length > 0 ? `User steering to honour: ${messages.join(" ")}` : "";
}

/**
 * A brand-new plan child has no conversation yet, so earlier turns are
 * prepended here. continueFrom children inherit that conversation instead.
 */
async function openingPrompt(
  ctx: Ctx,
  deps: AssetDrawDeps,
  instructions: string,
): Promise<AgentPrompt> {
  const prior = deps.loadPriorContext
    ? await deps.loadPriorContext(ctx.input)
    : { text: "", attachments: [] as AssetDrawInput["attachments"] };
  const text = prior.text.length > 0 ? `${prior.text}\n\n${instructions}` : instructions;
  return withAttachments(text, [...prior.attachments, ...ctx.input.attachments]);
}

async function planPhase(ctx: Ctx, deps: AssetDrawDeps): Promise<Transition> {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "plan" }>;
  if (checkpoint.planKey === undefined) {
    return (async () => {
      const context = await deps.loadPlanContext(ctx.input);
      const key = checkpoint.attempt === 0 ? "plan" : `plan-${checkpoint.attempt}`;
      const id = ctx.spawnAgent(key, {
        agentId: ctx.input.agentId,
        prompt: await openingPrompt(
          ctx,
          deps,
          `${buildPlanPrompt(ctx.input)}\nProject: ${context.projectName}. Asset: ${context.assetName} [${context.assetId}]. Palette: ${context.paletteSize} colours.`,
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
  if (outcome?.status === "cancelled") {
    return {
      status: "failed",
      error: "The plan child was cancelled; the run stops here.",
    };
  }
  if (outcome?.status !== "completed" || typeof outcome.output !== "string") {
    const key = "plan";
    if (retriesFor(checkpoint, key) < PLAN_RETRIES) {
      const attempt = retriesFor(checkpoint, key) + 1;
      console.error(
        `[task] plan child failed (${outcome?.status ?? "unknown"}); attempt ${attempt}/${PLAN_RETRIES}`,
      );
      const childKey = `plan-retry-${attempt}`;
      const id = ctx.spawnAgent(childKey, {
        agentId: ctx.input.agentId,
        prompt: await openingPrompt(ctx, deps, buildPlanPrompt(ctx.input)),
      });
      return {
        status: "waiting",
        checkpoint: {
          phase: "plan",
          attempt: checkpoint.attempt,
          planKey: childKey,
          retries: withRetry(checkpoint, key),
        },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    }
    return {
      status: "failed",
      error: `The plan phase did not complete after ${PLAN_RETRIES} retries: ${outcome?.status ?? "unknown"}.`,
    };
  }
  const parsed = parsePlanOutput(outcome.output);
  let checked: { ok: true } | { ok: false; error: string } = parsed.ok
    ? validatePlan(parsed.plan, {
        maxWorkers: ctx.input.maxWorkers,
        maxPalette: ctx.input.maxPalette,
        minFrames: minFramesFor(ctx.input.request),
      })
    : { ok: false, error: parsed.error };
  if (!checked.ok && checkpoint.attempt >= 1 && parsed.ok) {
    // A supervisor that keeps one frame against the motion rule is taken at
    // its word on the second attempt: the plan card shows the frames, and
    // failing the run over a still pose helps nobody.
    const lenient = validatePlan(parsed.plan, {
      maxWorkers: ctx.input.maxWorkers,
      maxPalette: ctx.input.maxPalette,
    });
    if (lenient.ok) checked = lenient;
  }
  if (!checked.ok) {
    if (checkpoint.attempt >= 1) {
      return { status: "failed", error: `The plan was invalid twice: ${checked.error}` };
    }
    const id = ctx.spawnAgent(`plan-${checkpoint.attempt + 1}`, {
      agentId: ctx.input.agentId,
      // The user already approved this plan. Continue that conversation and
      // correct the JSON; a fresh child would call present_plan and ask again.
      continueFrom: checkpoint.planKey,
      prompt: [
        "The user already approved this plan. Do not call present_plan.",
        `The plan JSON was rejected: ${checked.error}`,
        "Reply with one corrected JSON object and nothing else. Keep the approved frame names and worker split; change only what the rejection names.",
      ].join("\n"),
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
  // The approval is only half the job: a supervisor that ends its turn without
  // creating the frames it promised would leave the asset empty, so the task
  // checks the asset and names what is missing. A fresh asset ships with one
  // empty default frame; when the plan names its own frames, that frame is
  // renamed to the plan's first name instead of shipping beside it unpainted.
  let context = await deps.loadPlanContext(ctx.input);
  const planNames = plan.frames.map((frame) => frame.name);
  const adopted =
    planNames.length > 0 &&
    context.frames.length === 1 &&
    !planNames.includes(context.frames[0] ?? "");
  if (adopted && (await deps.claimDefaultFrame(ctx.input, planNames[0] ?? ""))) {
    context = await deps.loadPlanContext(ctx.input);
  }
  const missingFrames = planNames.filter((name) => !context.frames.includes(name));
  if (missingFrames.length > 0) {
    if (checkpoint.framesCreateTried !== true) {
      // This child only adds frames and palette, and it ends the moment it
      // has done so: given the agent's painting loop it painted the first
      // frame instead, which made the worker phase look optional.
      const id = ctx.spawnAgent("plan-create", {
        agentId: ctx.input.agentId,
        prompt: [
          `The user approved the plan, but these frames do not exist on the asset yet: ${missingFrames.join(", ")}.`,
          "Create each one now with add_frame using exactly those names, then add the plan's palette colours with set_palette.",
          "Do not call present_plan. The plan is already approved.",
          "Do not paint: painting belongs to the workers. Create the frames and palette, then answer with one short sentence.",
        ].join("\n"),
        continueFrom: checkpoint.planKey,
        maxModelTurns: FRAME_CREATION_TURNS,
      });
      return {
        status: "waiting",
        checkpoint: {
          ...checkpoint,
          framesCreateTried: true,
          framesCreateKey: "plan-create",
        },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    }
    return {
      status: "failed",
      error: `The approved frames were never created: ${missingFrames.join(", ")}.`,
    };
  }
  return (async () => {
    // Load every worker's context together, then spawn them in one turn.
    // The allSettled join below is what keeps the workers painting in parallel.
    const loaded = await Promise.all(
      plan.workers.map(async (worker) => ({
        worker,
        context: await deps.loadWorkerContext(ctx.input, plan, worker.key),
      })),
    );
    const workerIds: string[] = [];
    for (const { worker, context } of loaded) {
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
      const prompt = withAttachments(
        [
          workerInstructions,
          buildWorkerPrompt({
            ...context.promptData,
            ...(context.style !== undefined ? { style: context.style } : {}),
            ...(plan !== undefined ? { plan } : {}),
            attachments: ctx.input.attachments.length,
            ownedFrames,
            readOnlyFrames: readOnly,
            references,
          }),
        ].join("\n\n"),
        ctx.input.attachments,
      );
      // The slot retries this worker on its own, so a sibling stuck on a
      // question does not leave a failed worker sitting until the join.
      workerIds.push(
        ctx.spawn(`slot-${worker.key}`, workerAttemptTask, {
          agentId: ctx.input.agentId,
          workerKey: worker.key,
          prompt,
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
        workerKeys: plan.workers.map((worker) => `slot-${worker.key}`),
        workerSlots: true,
      },
      wait: { type: "children", ids: workerIds, policy: "allSettled" },
    };
  })();
}

function executePhase(ctx: Ctx, deps: AssetDrawDeps): Promise<Transition> | Transition {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "execute" }>;
  // workerIds are spawn ids (for the join); outcomes are found by key.
  const workerKeys = checkpoint.workerKeys ?? checkpoint.plan.workers.map((w) => w.key);
  const cancelledWorker = workerKeys.find(
    (key) => childOutput(ctx, key)?.status === "cancelled",
  );
  if (cancelledWorker !== undefined) {
    return {
      status: "failed",
      error: `Worker ${cancelledWorker} was cancelled; the run stops here.`,
    };
  }
  const failed = workerKeys.filter(
    (key) => childOutput(ctx, key)?.status !== "completed",
  );
  // A paint that never happened cannot be reviewed: the worker's assignment is
  // handed to a fresh child first.
  const retryable = checkpoint.workerSlots
    ? []
    : failed.filter((key) => retriesFor(checkpoint, `worker:${key}`) < CHILD_RETRIES);
  if (retryable.length > 0) {
    return (async () => {
      const ids: string[] = [];
      const keys: string[] = [];
      let retries = checkpoint.retries ?? {};
      const prepared = await Promise.all(
        retryable.map(async (key) => {
          const worker = checkpoint.plan.workers.find(
            (candidate) => candidate.key === key,
          );
          if (worker === undefined) return null;
          return {
            key,
            worker,
            context: await deps.loadWorkerContext(ctx.input, checkpoint.plan, key),
          };
        }),
      );
      for (const item of prepared) {
        if (item === null) continue;
        const { key, worker, context } = item;
        retries = withRetry({ retries }, `worker:${key}`);
        const childKey = `${key}-retry-${retriesFor(checkpoint, `worker:${key}`) + 1}`;
        const ownedFrames = checkpoint.plan.frames.filter((frame) =>
          worker.frames.includes(frame.name),
        );
        const readOnly = checkpoint.plan.frames
          .filter((frame) => !worker.frames.includes(frame.name))
          .map((frame) => frame.name);
        const references = checkpoint.plan.references
          .filter(
            (reference) =>
              reference.appliesTo === "all" ||
              reference.appliesTo.some((name) => worker.frames.includes(name)),
          )
          .map((reference) => ({ url: reference.url, note: reference.note }));
        ids.push(
          ctx.spawnAgent(childKey, {
            agentId: ctx.input.agentId,
            prompt: withAttachments(
              [
                workerInstructions,
                buildWorkerPrompt({
                  ...context.promptData,
                  ...(context.style !== undefined ? { style: context.style } : {}),
                  attachments: ctx.input.attachments.length,
                  ownedFrames,
                  readOnlyFrames: readOnly,
                  references,
                }),
              ].join("\n\n"),
              ctx.input.attachments,
            ),
          }),
        );
        keys.push(childKey);
      }
      return {
        status: "waiting",
        checkpoint: { ...checkpoint, workerIds: ids, workerKeys: keys, retries },
        wait: { type: "children", ids, policy: "allSettled" },
      };
    })();
  }
  // Jev may say a review is unnecessary; the supervisor's own plan may insist
  // on one. Either way, a failed worker always gets reviewed.
  const reviewWanted = ctx.input.review || checkpoint.plan.review;
  if (!reviewWanted && failed.length === 0) {
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
    const log =
      failed.length > 0
        ? [
            `Workers that did not finish: ${failed.map((key) => key.replace(/^slot-/, "")).join(", ")}.`,
          ]
        : [];
    const id = ctx.spawnAgent("review-1", {
      agentId: ctx.input.agentId,
      prompt: reviewPrompt(ctx, context, { round: 1, log }),
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
        log,
      },
      wait: { type: "children", ids: [id], policy: "allSettled" },
    };
  })();
}

/** One line per finished fix child: what it was told and what it reported. */
function fixLines(
  ctx: Ctx,
  checkpoint: { fixIds: string[] },
  fixes: ReviewFix[],
): string[] {
  const lines: string[] = [];
  for (const id of checkpoint.fixIds) {
    const child = ctx.children().find((record) => record.id === id);
    if (!child) continue;
    const fixOrder = Number(child.key.match(/-(\d+)$/)?.[1] ?? 0) - 1;
    const outcome = child.outcome;
    const reported =
      outcome?.status === "completed" && typeof outcome.output === "string"
        ? outcome.output
        : `did not finish (${outcome?.status ?? "unknown"}${outcome && "error" in outcome && outcome.error ? `: ${outcome.error}` : ""})`;
    lines.push(
      `- ${child.key} → ${child.key.startsWith("fix-unpainted") ? "empty frames" : `"${fixes[fixOrder]?.frame ?? "?"}"`}: ${reported}`,
    );
  }
  return lines;
}

function reviewPrompt(
  ctx: Ctx,
  context: string,
  checkpoint: { log?: string[]; round: number },
): string {
  const workLog = checkpoint.log ?? [];
  return [
    reviewInstructions,
    context,
    workLog.length > 0
      ? `Work so far (round ${checkpoint.round}; the frames you are reviewing already contain these fixes):\n${workLog.join("\n")}`
      : "",
    deliveredSteers(ctx),
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function fixPrompt(
  fix: ReviewFix,
  intent: string | undefined,
  workLog: string[],
): string {
  return [
    fixInstructions,
    `Frame: "${fix.frame}".${fix.layers && fix.layers.length > 0 ? ` Layers: ${fix.layers.join(", ")}.` : ""}`,
    fix.referenceFrame !== undefined
      ? `Match it against "${fix.referenceFrame}" — read that frame and copy the region you need instead of redrawing it.`
      : "",
    intent !== undefined ? `Its intent: ${intent}` : "",
    `The review asks: ${fix.note}`,
    workLog.length > 0 ? `Earlier work this task:\n${workLog.join("\n")}` : "",
    fix.layers && fix.layers.length > 0
      ? `Paint only ${fix.layers.map((layer) => `the ${layer} layer`).join(" and ")} of this frame, then save_frame and stop.`
      : "Paint only this frame, then save_frame and stop.",
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function reviewPhase(ctx: Ctx, deps: AssetDrawDeps): Promise<Transition> | Transition {
  const checkpoint = ctx.checkpoint as Extract<AssetDrawCheckpoint, { phase: "review" }>;
  const names = checkpoint.plan.frames.map((frame) => frame.name);
  const log = checkpoint.log ?? [];

  const settle = async (
    verdict: { ok: boolean; summary?: string; notes: string[] },
    rounds: number,
  ): Promise<Transition> => {
    const unpainted = await deps.unpaintedFrames(ctx.input, names);
    if (unpainted.length === 0) {
      return {
        status: "completed",
        output: {
          assetId: checkpoint.plan.assetId,
          frames: names,
          rounds,
          workers: checkpoint.plan.workers.length,
          review: verdict,
        },
      };
    }
    // An unpainted frame is the one thing the reviewer's eyes can miss and the
    // task can prove: it gets one named repair, then names the failure.
    if ((checkpoint.retries?.unpainted ?? 0) < 1) {
      const id = ctx.spawnAgent("fix-unpainted", {
        agentId: ctx.input.agentId,
        prompt: [
          fixInstructions,
          `These frames are still empty: ${unpainted.join(", ")}.`,
          "Paint each of them now with the painting tools, save_frame, then answer with one short sentence.",
        ].join("\n\n"),
        continueFrom: checkpoint.planKey,
        // One repair, one bounded attempt: this backstop exists to catch what
        // a review missed, not to become a second, unbounded painting loop.
        maxModelTurns: FIX_MODEL_TURNS,
      });
      return {
        status: "waiting",
        checkpoint: {
          ...checkpoint,
          retries: { ...checkpoint.retries, unpainted: 1 },
        },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    }
    return {
      status: "failed",
      error: `The reviews passed, but these frames are still unpainted: ${unpainted.join(", ")}.`,
    };
  };

  if (checkpoint.reviewKey === undefined) {
    return (async () => {
      const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
      const key = `review-${checkpoint.round}`;
      const id = ctx.spawnAgent(key, {
        agentId: ctx.input.agentId,
        prompt: reviewPrompt(ctx, context, checkpoint),
        continueFrom: checkpoint.planKey,
      });
      return {
        status: "waiting",
        checkpoint: { ...checkpoint, reviewKey: key },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    })();
  }

  if (checkpoint.fixIds.length > 0) {
    // The fixes finished: log what they reported, then ask the reviewer again.
    const reviewed = ctx.children().find((record) => record.key === checkpoint.reviewKey);
    const verdict =
      reviewed?.outcome?.status === "completed"
        ? parseReviewVerdict(reviewed.outcome.output)
        : undefined;
    const fixes = verdict?.ok === true ? verdict.verdict.fixes : [];
    const nextLog = [...log, ...fixLines(ctx, checkpoint, fixes)];
    return (async () => {
      const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
      const round = checkpoint.round + 1;
      const key = `review-${round}`;
      const id = ctx.spawnAgent(key, {
        agentId: ctx.input.agentId,
        prompt: reviewPrompt(ctx, context, { round, log: nextLog }),
        continueFrom: checkpoint.planKey,
      });
      return {
        status: "waiting",
        checkpoint: {
          phase: "review",
          plan: checkpoint.plan,
          planKey: checkpoint.planKey,
          round,
          reviewKey: key,
          fixIds: [],
          log: nextLog,
          ...(checkpoint.retries ? { retries: checkpoint.retries } : {}),
        },
        wait: { type: "children", ids: [id], policy: "allSettled" },
      };
    })();
  }

  const outcome = childOutput(ctx, checkpoint.reviewKey);
  if (outcome?.status === "cancelled") {
    return {
      status: "failed",
      error: "The review child was cancelled; the run stops here.",
    };
  }
  if (outcome?.status !== "completed" || outcome.output === undefined) {
    const key = `review:${checkpoint.round}`;
    if (retriesFor(checkpoint, key) < CHILD_RETRIES) {
      return (async () => {
        const context = await deps.loadReviewContext(ctx.input, checkpoint.plan);
        const childKey = `${checkpoint.reviewKey}-retry-${retriesFor(checkpoint, key) + 1}`;
        const id = ctx.spawnAgent(childKey, {
          agentId: ctx.input.agentId,
          prompt: reviewPrompt(ctx, context, checkpoint),
          continueFrom: checkpoint.planKey,
        });
        return {
          status: "waiting",
          checkpoint: {
            ...checkpoint,
            reviewKey: childKey,
            retries: withRetry(checkpoint, key),
          },
          wait: { type: "children", ids: [id], policy: "allSettled" },
        };
      })();
    }
    return {
      status: "failed",
      error: `The review phase did not complete after ${CHILD_RETRIES} retries: ${outcome?.status ?? "unknown"}.`,
    };
  }

  const parsed = parseReviewVerdict(outcome.output);
  if (!parsed.ok) {
    // The verdict is the reviewer's contract; an answer that is not one is a
    // system fault (wrong agent or broken output), not an artistic judgement.
    return { status: "failed", error: parsed.error };
  }
  const { verdict } = parsed;
  const notes = verdict.fixes.map((fix) => `${fix.frame}: ${fix.note}`);
  if (verdict.done) {
    // The reviewer's judgement is the outcome; the fixes it listed alongside
    // `ok` are carried into the notes the console shows, not acted on.
    return settle(
      {
        ok: true,
        ...(verdict.summary !== undefined ? { summary: verdict.summary } : {}),
        notes,
      },
      checkpoint.round,
    );
  }
  const frames = new Set(names);
  const fixes = verdict.fixes.filter((fix) => frames.has(fix.frame));
  if (fixes.length === 0) {
    return settle(
      {
        ok: false,
        ...(verdict.summary !== undefined ? { summary: verdict.summary } : {}),
        notes: verdict.fixes.map((fix) => `${fix.frame}: ${fix.note}`),
      },
      checkpoint.round,
    );
  }
  const fixIds = fixes.map((fix, index) => {
    const intent = checkpoint.plan.frames.find(
      (frame) => frame.name === fix.frame,
    )?.intent;
    return ctx.spawnAgent(`fix-${checkpoint.round}-${index + 1}`, {
      agentId: ctx.input.agentId,
      prompt: fixPrompt(fix, intent, log),
      continueFrom: checkpoint.reviewKey,
      maxModelTurns: FIX_MODEL_TURNS,
    });
  });
  return {
    status: "waiting",
    checkpoint: { ...checkpoint, fixIds },
    wait: { type: "children", ids: fixIds, policy: "allSettled" },
  };
}

/**
 * plan | worker | review | fix, from a task child's key. Every role has its
 * own key prefix — `w1`…`w4`, `plan-*`, `review-N`, `fix-*` — and anything
 * else is unknown: a prefix check on the first letter once read a plan frame
 * called "putar-1" as a worker, which bound the frame-creation child to the
 * first frame and sent it down the paint path.
 */
export function roleOfKey(key: string): "plan" | "worker" | "review" | "fix" | undefined {
  if (key === "plan" || key.startsWith("plan-")) return "plan";
  if (/^w[1-4](-|$)/.test(key)) return "worker";
  if (key.startsWith("review")) return "review";
  if (key === "fix" || key.startsWith("fix-")) return "fix";
  return undefined;
}

export type PriorContext = {
  /** Transcript of every earlier user request and the agents' steps. */
  text: string;
  /** Reference images from those turns, oldest first. */
  attachments: AssetDrawInput["attachments"];
};

export type PlanContext = {
  projectName: string;
  assetName: string;
  assetId: string;
  paletteSize: number;
  styleLines: string[];
  /** The names the asset's frames carry right now. */
  frames: string[];
};
/** The project style a worker prompt prints; absent keeps the format default. */
export type WorkerContext = {
  style?: WorkerPromptInput["style"];
  promptData: Omit<
    WorkerPromptInput,
    "ownedFrames" | "readOnlyFrames" | "references" | "style"
  >;
};
export type AssetDrawDeps = {
  loadPlanContext(input: AssetDrawInput): Promise<PlanContext>;
  /**
   * Every earlier drawing turn on this asset: user text, reference images,
   * and compact agent steps. Omitted in tests, which then plan from this
   * request alone. A fresh plan child (including a failed-child retry) reads
   * it. A continueFrom correction already has the conversation.
   */
  loadPriorContext?(input: AssetDrawInput): Promise<PriorContext>;
  /**
   * A fresh asset ships with one empty default frame. When the plan names its
   * own frames, that frame is renamed to the plan's first name so the asset
   * never ships an unpainted orphan. Painted frames are never touched; the
   * answer says whether the frame was claimed.
   */
  claimDefaultFrame(input: AssetDrawInput, name: string): Promise<boolean>;
  /**
   * The plan's frames whose pixels are all transparent. The review reads the
   * frames with eyes; this is the deterministic backstop that keeps a run
   * from reporting "completed" beside an empty frame.
   */
  unpaintedFrames(input: AssetDrawInput, names: string[]): Promise<string[]>;
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
