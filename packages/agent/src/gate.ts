import { askJev, type JevQuestion } from "./jev.js";
import type { RunBinding } from "./runs.js";

/**
 * The Jev request check for destructive tool calls. Jev answers typed
 * questions about the call against the user's request; the code turns the
 * probabilities into one of three outcomes, the way OpenRouter's tool-gate
 * cookbook prescribes:
 *
 * - `approve`: every check is at or above `GATE_APPROVE_AT`, so the call runs.
 * - `block`: some check is at or below `GATE_BLOCK_AT`, so the call is refused
 *   to the model without touching the frame.
 * - `review`: anything in the middle pauses for the human through the normal
 *   approval flow.
 *
 * The thresholds are deliberately far apart so a human only sees the calls a
 * check is neither clearly true nor clearly false about.
 */
export type ToolGateOutcome = {
  outcome: "approve" | "block" | "review";
  reason: string;
  checks: Record<string, number>;
};

const GATE_APPROVE_AT = 0.9;
const GATE_BLOCK_AT = 0.1;

type NoulQuestion = JevQuestion & { type: "noul" };

const supportedQuestion: NoulQuestion = {
  type: "noul",
  instructions:
    "The user's request in `request` asks for `call`, or `call` is a direct step of what they asked for. `call.description` says what the call does.",
  criteria: {
    true: "The request asks for this change, or the change is a direct step of what the request asks for.",
    false:
      "The request does not ask for this change, and the change is not a step of what the request asks for.",
  },
};

const proportionateQuestion: NoulQuestion = {
  type: "noul",
  instructions:
    "`call` stays within the scope of `request`: it does not clear, recolor, or replace a much larger part of the frame than the request describes. Compare `call.args` against `asset.width`, `asset.height`, and `request`.",
  criteria: {
    true: "The change touches only as much of the frame as the request describes.",
    false:
      "The change touches a much larger part of the frame than the request describes.",
  },
};

/**
 * What each destructive tool is judged on. The description is written for the
 * check, not for the drawing model: it tells Jev what the call means and how
 * it normally fits into drawing. A palette change, a layer removal, a frame
 * delete, or a canvas resize is a single-question call; a region clear or a
 * color swap also has a size that can outgrow the request.
 */
const TOOL_GATES: Record<
  string,
  { description: string; questions: Record<string, NoulQuestion> }
> = {
  clear_region: {
    description:
      "Clear a rectangle of a layer to transparency (erase pixels). Painting new artwork often begins by clearing the area the new artwork will occupy.",
    questions: { supported: supportedQuestion, proportionate: proportionateQuestion },
  },
  replace_color: {
    description:
      "Replace every pixel of one palette color with another across the frame (or one layer).",
    questions: { supported: supportedQuestion, proportionate: proportionateQuestion },
  },
  set_palette: {
    description:
      "Choose the colors the frame will paint with by replacing the frame's palette. Drawing a sprite in specific colors requires setting a palette; index 0 stays transparent.",
    questions: { supported: supportedQuestion },
  },
  remove_layer: {
    description: "Remove a layer and everything painted on it from the frame.",
    questions: { supported: supportedQuestion },
  },
  delete_frame: {
    description:
      "Delete a whole frame of the animation and everything painted on it. Drawing a new animation often starts by clearing away an old frame the user no longer wants.",
    questions: { supported: supportedQuestion },
  },
  resize_canvas: {
    description:
      "Resize the whole canvas, which every frame adopts; pixels outside the new size are dropped. Users often ask for a specific canvas size in the same sentence as what to draw.",
    questions: { supported: supportedQuestion },
  },
};

/** Every probability selects the outcome; formatting keeps reasons readable. */
export function toGateOutcome(checks: Record<string, number>): ToolGateOutcome {
  const pairs = Object.entries(checks);
  const pair = pairs.map(([name, value]) => `${name}=${value.toFixed(2)}`).join(", ");
  if (pairs.every(([, value]) => value >= GATE_APPROVE_AT)) {
    return { outcome: "approve", reason: pair, checks };
  }
  if (pairs.some(([, value]) => value <= GATE_BLOCK_AT)) {
    return { outcome: "block", reason: `not supported by the request (${pair})`, checks };
  }
  return {
    outcome: "review",
    reason: `the request check is not clear (${pair})`,
    checks,
  };
}

/**
 * A deterministic first check, the way the cookbook's arithmetic check runs
 * before Jev: when the call provably cannot touch a painted pixel (an empty
 * frame, an empty region, a color no pixel uses), there is nothing for Jev to
 * judge and the call is safe to run.
 */
export function gateIsHarmless(
  run: RunBinding,
  toolName: string,
  args: unknown,
): boolean {
  const frameId = (args as { frameId?: string }).frameId ?? run.currentFrameId;
  const frame = frameId !== undefined ? run.frames.get(frameId) : undefined;
  if (!frame) return false;
  const { buffer } = frame;
  const pixelsOf = (layerId: string) =>
    buffer.layers.find((layer) => layer.id === layerId)?.pixels;
  if (toolName === "clear_region") {
    const { layerId, x, y, width, height } = args as {
      layerId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    };
    if (![x, y, width, height].every((value) => Number.isInteger(value))) return false;
    const pixels = pixelsOf(layerId);
    if (!pixels) return false;
    const top = Math.max(0, y);
    const bottom = Math.min(buffer.height, y + height);
    const left = Math.max(0, x);
    const right = Math.min(buffer.width, x + width);
    for (let row = top; row < bottom; row++) {
      for (let column = left; column < right; column++) {
        if (pixels[row * buffer.width + column] !== 0) return false;
      }
    }
    return true;
  }
  if (toolName === "replace_color") {
    const { layerId, from } = args as { layerId?: string; from: number };
    if (!Number.isInteger(from)) return false;
    const layers =
      layerId !== undefined
        ? [pixelsOf(layerId)]
        : buffer.layers.map((layer) => layer.pixels);
    return !layers.some((pixels) => pixels?.includes(from));
  }
  if (toolName === "set_palette") {
    // No painted pixel can lose its color when no pixel is painted.
    return !buffer.layers.some((layer) => layer.pixels.some((value) => value !== 0));
  }
  if (toolName === "resize_canvas") {
    const { width, height } = args as { width: number; height: number };
    return width === run.width && height === run.height;
  }
  return false;
}

/**
 * Ask Jev whether the call is supported by, and proportionate to, the user's
 * request. A missing key, an unreachable provider, an unknown tool, or an
 * answer shape this client does not understand is an error naming the cause;
 * it never becomes an approval.
 */
export async function gateToolCall(
  run: RunBinding,
  toolName: string,
  args: unknown,
): Promise<ToolGateOutcome> {
  const config = TOOL_GATES[toolName];
  if (!config) {
    throw new Error(`${toolName} does not pass the Jev request check.`);
  }
  const frame =
    run.currentFrameId !== undefined ? run.frames.get(run.currentFrameId) : undefined;
  const state = {
    request: run.request ?? "(this run did not record the user's request)",
    asset: { name: run.assetName, width: run.width, height: run.height },
    frame: { name: frame?.name },
    palette: run.palette,
    call: { tool: toolName, description: config.description, args },
  };
  const started = Date.now();
  const { answers, usage, model } = await askJev(state, config.questions, {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.JEV_MODEL,
  });
  const checks: Record<string, number> = {};
  for (const name of Object.keys(config.questions)) {
    const probability = answers[name]?.noul;
    if (probability === undefined) {
      throw new Error(`Jev did not answer the ${name} check.`);
    }
    checks[name] = probability;
  }
  const outcome = toGateOutcome(checks);
  run.onJevCheck?.({
    toolName,
    outcome: outcome.outcome,
    reason: outcome.reason,
    checks,
    durationMs: Date.now() - started,
    model,
    usage,
  });
  return outcome;
}

/**
 * One verdict awaits its tool call at a time: `requiresApproval` records it and
 * the tool's own execution consumes it. A denied review leaves its entry
 * unused; the next call for the same run and tool overwrites it.
 */
const outcomes = new Map<string, ToolGateOutcome>();

const outcomeKey = (runId: string, toolName: string) => `${runId}:${toolName}`;

export function rememberGateOutcome(
  runId: string,
  toolName: string,
  outcome: ToolGateOutcome,
): void {
  outcomes.set(outcomeKey(runId, toolName), outcome);
}

export function takeGateOutcome(
  runId: string,
  toolName: string,
): ToolGateOutcome | undefined {
  const key = outcomeKey(runId, toolName);
  const outcome = outcomes.get(key);
  outcomes.delete(key);
  return outcome;
}

/** Drop every verdict a finished run left behind. */
export function clearGateOutcomes(runId: string): void {
  const prefix = `${runId}:`;
  for (const key of outcomes.keys()) {
    if (key.startsWith(prefix)) outcomes.delete(key);
  }
}
