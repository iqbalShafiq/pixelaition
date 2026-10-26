import { z } from "zod";
import { MAX_COLORS, MAX_SIZE, MIN_SIZE } from "@pixelaition/pixel";

/**
 * The plan a supervisor produces for one drawing request, before a single
 * worker spawns. Task code validates every field; nothing downstream trusts
 * the model's prose.
 */

/*
 * Text fields carry no length cap. A cap on prose does not protect the model —
 * it silently cuts the instructions a later role needs — and the context is
 * bounded by the runtime's compaction of the conversation, not by truncating
 * the fields that carry intent. Only fields whose answer is "pick a different
 * name/size" keep a bound: frame, layer and worker names at 40 characters,
 * the plan's palette budget, the worker count.
 */
export const drawPlanFrameSchema = z.object({
  name: z.string().min(1).max(40),
  intent: z.string().min(1),
  /**
   * A frame is its own pixel canvas. A request that names a real output size
   * (X profile, X cover, LinkedIn cover) carries that size here so add_frame
   * creates the right canvas instead of silently inheriting the asset's size.
   */
  width: z.number().int().min(MIN_SIZE).max(MAX_SIZE).optional(),
  height: z.number().int().min(MIN_SIZE).max(MAX_SIZE).optional(),
  layers: z
    .array(z.string().min(1).max(40))
    .describe("Layers this frame paints on, by the plan's layer names."),
});
export const paletteAdditionSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  name: z.string().min(1).max(40),
});
export const planReferenceSchema = z.object({
  url: z.string().url(),
  note: z.string(),
  // Models naturally name one frame ("duduk") or list several in one string
  // ("ancang, melompat"). Both mean the same as the explicit array form.
  appliesTo: z
    .union([
      z.literal("all"),
      z.array(z.string().min(1).max(40)).min(1),
      z.string().min(1),
    ])
    .transform((value) => {
      if (value === "all" || Array.isArray(value)) return value;
      return value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
    })
    .refine((value) => value === "all" || value.length > 0, {
      message: "Name at least one frame or use all.",
    }),
});
export const planWorkerSchema = z.object({
  key: z.string().regex(/^w[1-4]$/),
  frames: z.array(z.string().min(1).max(40)).min(1),
});
export const drawPlanSchema = z.object({
  assetId: z.string().min(1),
  frames: z.array(drawPlanFrameSchema).min(1),
  palette: z.array(paletteAdditionSchema),
  references: z.array(planReferenceSchema).max(8),
  workers: z.array(planWorkerSchema).min(1).max(4),
  /**
   * Existing frames this plan replaces and wants removed. The supervisor
   * executes it after adding the planned frames, so a blank default `idle`
   * cannot survive a request that defines a new set of canvases.
   */
  removeFrames: z.array(z.string().min(1).max(40)).optional(),
  review: z.boolean(),
});
export type DrawPlan = z.infer<typeof drawPlanSchema>;
export type DrawPlanFrame = z.infer<typeof drawPlanFrameSchema>;

/**
 * The review pass's answer: a verdict, not free prose. `done` finishes the
 * task and is the reviewer's own call; `fixes` orders another round when that
 * round can plausibly land. `summary` may name what remains even on `done` —
 * a finished drawing with a small flaw is a decision, not a failure. The note
 * is what a fix worker receives, so it carries the whole instruction — no
 * field here is cut.
 */
export const reviewFixSchema = z.object({
  frame: z.string().min(1).describe("The frame to change, by name."),
  layers: z
    .array(z.string().min(1))
    .optional()
    .describe("Layers to touch; omit for any."),
  note: z
    .string()
    .min(1)
    .describe("What to change, giving the fix worker everything it needs."),
  referenceFrame: z
    .string()
    .optional()
    .describe("A frame to copy the matching part from, when one matched better."),
});
export const reviewVerdictSchema = z.object({
  done: z.boolean(),
  summary: z.string().optional(),
  fixes: z.array(reviewFixSchema).default([]),
});
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;
export type ReviewFix = z.infer<typeof reviewFixSchema>;

/**
 * Read a review child's answer. An object that validates is used as is; a
 * string that is exactly one JSON object is parsed; anything else is a system
 * failure (the reviewer's own contract), never a silent "ok".
 */
export function parseReviewVerdict(
  output: unknown,
): { ok: true; verdict: ReviewVerdict } | { ok: false; error: string } {
  const value = typeof output === "string" ? tryJson(output) : output;
  const parsed = reviewVerdictSchema.safeParse(value);
  if (parsed.success) return { ok: true, verdict: parsed.data };
  const issue = parsed.error.issues[0];
  return {
    ok: false,
    error: `The review answer is not a verdict (${issue?.path.join(".") ?? "value"} ${issue?.message ?? "invalid"}).`,
  };
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type PlanLimits = {
  maxWorkers: number;
  maxPalette: number;
  /** Key frames a motion request needs; 1 leaves a still pose free to pass. */
  minFrames?: number;
};

/** How many colours the palette can still take: 256 entries less what it holds. */
export function paletteCapacity(currentLength: number): number {
  return Math.max(0, MAX_COLORS + 1 - currentLength);
}

/** Every rejection names what the supervisor must fix in its next attempt. */
export function validatePlan(
  plan: DrawPlan,
  limits: PlanLimits,
): { ok: true } | { ok: false; error: string } {
  const seen = new Set<string>();
  for (const frame of plan.frames) {
    if (seen.has(frame.name)) {
      return { ok: false, error: `The plan names frame "${frame.name}" twice.` };
    }
    seen.add(frame.name);
  }
  const minFrames = limits.minFrames ?? 1;
  if (plan.frames.length < minFrames) {
    return {
      ok: false,
      error: `The request describes movement, so the plan needs at least ${minFrames} key frames; it drew ${plan.frames.length}.`,
    };
  }
  for (const name of plan.removeFrames ?? []) {
    if (seen.has(name)) {
      return {
        ok: false,
        error: `The plan both creates and removes frame "${name}"; choose one.`,
      };
    }
  }
  const keys = new Set<string>();
  for (const worker of plan.workers) {
    if (keys.has(worker.key)) {
      return { ok: false, error: `The plan uses worker key "${worker.key}" twice.` };
    }
    keys.add(worker.key);
  }
  if (plan.workers.length > limits.maxWorkers) {
    return {
      ok: false,
      error: `The plan uses ${plan.workers.length} workers; the cap is ${limits.maxWorkers}.`,
    };
  }
  const assigned = new Map<string, string>();
  for (const worker of plan.workers) {
    for (const name of worker.frames) {
      if (!seen.has(name)) {
        return {
          ok: false,
          error: `Worker ${worker.key} names unknown frame "${name}".`,
        };
      }
      const other = assigned.get(name);
      if (other !== undefined) {
        return { ok: false, error: `Frame "${name}" is assigned to two workers.` };
      }
      assigned.set(name, worker.key);
    }
  }
  for (const frame of plan.frames) {
    if (!assigned.has(frame.name)) {
      return { ok: false, error: `Frame "${frame.name}" is not assigned to a worker.` };
    }
  }
  if (plan.palette.length > limits.maxPalette) {
    return {
      ok: false,
      error: `The plan adds ${plan.palette.length} colour${plan.palette.length === 1 ? "" : "s"}; the palette has room for ${limits.maxPalette} more.`,
    };
  }
  for (const reference of plan.references) {
    if (!reference.url.startsWith("https://")) {
      return { ok: false, error: `Reference "${reference.url}" must be an https URL.` };
    }
    if (reference.appliesTo !== "all") {
      for (const name of reference.appliesTo) {
        if (!seen.has(name)) {
          return {
            ok: false,
            error: `Reference "${reference.url}" names unknown frame "${name}".`,
          };
        }
      }
    }
  }
  return { ok: true };
}
