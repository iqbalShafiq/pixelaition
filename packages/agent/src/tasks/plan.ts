import { z } from "zod";
import { MAX_COLORS } from "@pixelaition/pixel";

/**
 * The plan a supervisor produces for one drawing request, before a single
 * worker spawns. Task code validates every field; nothing downstream trusts
 * the model's prose.
 */

export const drawPlanFrameSchema = z.object({
  name: z.string().min(1).max(40),
  intent: z.string().min(1).max(320),
  layers: z.array(z.string().min(1).max(40)),
});
export const paletteAdditionSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  name: z.string().min(1).max(40),
});
export const planReferenceSchema = z.object({
  url: z.string().url(),
  note: z.string().max(400),
  appliesTo: z.union([z.literal("all"), z.array(z.string().min(1).max(40)).min(1)]),
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
  review: z.boolean(),
});
export type DrawPlan = z.infer<typeof drawPlanSchema>;
export type DrawPlanFrame = z.infer<typeof drawPlanFrameSchema>;

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
